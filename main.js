const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const startNode = document.getElementById("startNode");
const endNode = document.getElementById("endNode");
const submitBtn = document.getElementById("submitBtn");

const statusTag = document.getElementById("statusTag");
const pathTag = document.getElementById("pathTag");
const logField = document.getElementById("logField");

// MediaWiki API Constants
const BASE_URL = "https://en.wikipedia.org/w/api.php";
const BASE_ACTION = "query";
const BASE_FORMAT = "json";
const BASE_ORIGIN = "*";

async function fetchWithRetry(url, maxRetries = 6, initialDelay = 2000) {
    let delay = initialDelay;
    
    for (let i = 0; i < maxRetries; i++) {
        const response = await fetch(url);
        
        if (response.ok) {
            return response.json();
        }
        
        if (response.status === 429) {
            console.warn(`Rate limit hit (429). Retrying in ${delay}ms...`);
            await sleep(delay);
            delay *= 2;
            continue;
        }
        
        throw new Error(`HTTP Error: ${response.status}`);
    }
    
    throw new Error("Max retries reached due to rate limiting.");
}

// Global cache for verified human entities
const humanCache = new Map();

// 1 single API call to verify if a single title is human
async function verifyIsHuman(title) {
    if (humanCache.has(title)) {
        return humanCache.get(title);
    }

    const enc = encodeURIComponent(title);
    const uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${enc}&prop=categories&cllimit=500&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1`;

    try {
        const data = await fetchWithRetry(uri);
        if (!data.query || !data.query.pages) {
            humanCache.set(title, false);
            return false;
        }

        const page = Object.values(data.query.pages)[0];
        if (!page.categories) {
            humanCache.set(title, false);
            return false;
        }

        let isHuman = false;
        for (let i = 0; i < page.categories.length; i++) {
            const cat = page.categories[i].title;
            if (cat.includes("Category:Living people") || 
                /Category:\d{4} births/.test(cat) || 
                /Category:\d{4} deaths/.test(cat)) {
                isHuman = true;
                break;
            }
        }

        humanCache.set(title, isHuman);
        return isHuman;
    } catch (err) {
        console.error("Validation error for:", title, err);
        return false;
    }
}

// Fetch ALL raw outgoing links with full pagination (no filtering)
async function fetchRawForwardLinks(title) {
    const enc = encodeURIComponent(title);
    let uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${enc}&prop=links&pllimit=500&plnamespace=0&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1`;
    const links = [];

    while (uri) {
        try {
            const data = await fetchWithRetry(uri);
            if (!data.query || !data.query.pages) break;

            const page = Object.values(data.query.pages)[0];
            if (page.links) {
                for (let i = 0; i < page.links.length; i++) {
                    links.push(page.links[i].title);
                }
            }

            if (data.continue && data.continue.plcontinue) {
                uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${enc}&prop=links&pllimit=500&plnamespace=0&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1&plcontinue=${encodeURIComponent(data.continue.plcontinue)}`;
                await sleep(50);
            } else {
                uri = null;
            }
        } catch (err) {
            console.error("Error fetching outgoing links:", err);
            break;
        }
    }
    return links;
}

// Fetch ALL raw inbound links with full pagination (no filtering)
async function fetchRawBackwardLinks(title) {
    const enc = encodeURIComponent(title);
    let uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${enc}&prop=linkshere&lhlimit=500&lhnamespace=0&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1`;
    const links = [];

    while (uri) {
        try {
            const data = await fetchWithRetry(uri);
            if (!data.query || !data.query.pages) break;

            const page = Object.values(data.query.pages)[0];
            if (page.linkshere) {
                for (let i = 0; i < page.linkshere.length; i++) {
                    links.push(page.linkshere[i].title);
                }
            }

            if (data.continue && data.continue.lhcontinue) {
                uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${enc}&prop=linkshere&lhlimit=500&lhnamespace=0&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1&lhcontinue=${encodeURIComponent(data.continue.lhcontinue)}`;
                await sleep(50);
            } else {
                uri = null;
            }
        } catch (err) {
            console.error("Error fetching inbound links:", err);
            break;
        }
    }
    return links;
}

async function bidirectionalBfsShortestPath(start, end) {
    if (start === end) return [start];

    // Initialize root nodes in cache
    humanCache.set(start, true);
    humanCache.set(end, true);

    // Frontier maps: Map<Title, PathArray>
    let forwardFrontier = new Map([[start, [start]]]);
    let backwardFrontier = new Map([[end, [end]]]);

    const forwardVisited = new Map([[start, [start]]]);
    const backwardVisited = new Map([[end, [end]]]);

    let maxAPIRequests = 200;
    let requestMade = 0;

    while (forwardFrontier.size > 0 && backwardFrontier.size > 0 && requestMade < maxAPIRequests) {
        // Expand the smaller frontier first to control branching factor
        const expandForward = forwardFrontier.size <= backwardFrontier.size;
        const currentFrontier = expandForward ? forwardFrontier : backwardFrontier;
        const nextFrontier = new Map();

        for (const [curNode, curPath] of currentFrontier) {
            if (requestMade >= maxAPIRequests) break;

            // LAZY VALIDATION: Verify humanity only when dequeuing for expansion
            if (curNode !== start && curNode !== end) {
                const isHuman = await verifyIsHuman(curNode);
                requestMade++;
                if (!isHuman) {
                    continue; // Skip expanding non-human entities
                }
            }

            logField.innerHTML = `Log: Expanding: ${curNode} (${expandForward ? "Forward" : "Backward"})`;

            // Retrieve raw outgoing or incoming connections
            const rawNeighbors = expandForward 
                ? await fetchRawForwardLinks(curNode) 
                : await fetchRawBackwardLinks(curNode);
            requestMade++;

            for (let i = 0; i < rawNeighbors.length; i++) {
                const neighbor = rawNeighbors[i];
                const opposingVisited = expandForward ? backwardVisited : forwardVisited;

                // Intersection detected
                if (opposingVisited.has(neighbor)) {
                    // Validate bridge node before confirming path
                    const bridgeIsHuman = await verifyIsHuman(neighbor);
                    requestMade++;

                    if (bridgeIsHuman) {
                        const pathStart = expandForward ? [...curPath, neighbor] : opposingVisited.get(neighbor);
                        const pathEnd = expandForward ? opposingVisited.get(neighbor) : [...curPath, neighbor];

                        const reversedEnd = [...pathEnd].reverse().slice(1);
                        return [...pathStart, ...reversedEnd];
                    }
                }

                const myVisited = expandForward ? forwardVisited : backwardVisited;
                if (!myVisited.has(neighbor)) {
                    const nextPath = [...curPath, neighbor];
                    myVisited.set(neighbor, nextPath);
                    nextFrontier.set(neighbor, nextPath);
                }
            }

            await sleep(50);
        }

        if (expandForward) {
            forwardFrontier = nextFrontier;
        } else {
            backwardFrontier = nextFrontier;
        }
    }

    return "Path not found or request limit reached.";
}

submitBtn.addEventListener("click", async () => {
    pathTag.innerText = "Path: Finding...";
    statusTag.innerHTML = "Status: Finding...";

    const startTime = performance.now();

    const start = startNode.value.trim();
    const end = endNode.value.trim();

    try {
        const result = await bidirectionalBfsShortestPath(start, end);
        const endTime = performance.now();

        pathTag.innerText = `Path: ${JSON.stringify(result)}`;
        statusTag.innerHTML = `Status: Success! Path built in ${((endTime - startTime) / 1000).toFixed(2)}s`;
    } catch (error) {
        console.error("Execution error:", error);
        pathTag.innerHTML = `Path: []`;
        statusTag.innerHTML = `Status: Failed!`;
    }
});