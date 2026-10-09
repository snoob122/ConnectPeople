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

const NON_HUMAN_REGEX = /\b(album|song|film|band|soundtrack|season|discography|tour|awards?|records?|university|county|school|dynasty|battle|treaty|elections?|presidency|administration|cabinet|politics|history|geography|discography|videography|list of)\b|\d{4}|^\d+$|\(.*(album|film|song|single|band|soundtrack|season|episode|TV series|novel|EP|company|record label|musical).*\)$/i;

function couldBeHuman(title) {
    if (!title || typeof title !== "string") return false;
    return !NON_HUMAN_REGEX.test(title);
}

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

async function asyncPool(limit, items, iteratorFn) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
        const p = Promise.resolve().then(() => iteratorFn(item));
        results.push(p);
        executing.add(p);

        const clean = () => executing.delete(p);
        p.then(clean, clean);

        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }

    return Promise.all(results);
}

// Bulk verifies up to 50 nodes in 1 HTTP call
async function verifyHumansBulk(titles) {
    const unverified = titles.filter(t => !humanCache.has(t));
    if (unverified.length === 0) return;

    for (let i = 0; i < unverified.length; i += 50) {
        const batch = unverified.slice(i, i + 50);
        const joined = batch.map(encodeURIComponent).join('|');
        const uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${joined}&prop=categories&cllimit=500&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1`;

        try {
            const data = await fetchWithRetry(uri);
            if (!data.query || !data.query.pages) continue;

            const pages = Object.values(data.query.pages);
            for (const page of pages) {
                let isHuman = false;
                if (page.categories) {
                    for (const cat of page.categories) {
                        const title = cat.title;
                        if (title.includes("Category:Living people") || 
                            /Category:\d{4} births/.test(title) || 
                            /Category:\d{4} deaths/.test(title)) {
                            isHuman = true;
                            break;
                        }
                    }
                }
                humanCache.set(page.title, isHuman);
            }
        } catch (err) {
            console.error("Bulk validation error:", err);
        }
    }
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

    let maxAPIRequests = 2000;
    let requestMade = 0;

    const CONCURRENCY_LIMIT = 2;

    while (forwardFrontier.size > 0 && backwardFrontier.size > 0 && requestMade < maxAPIRequests) {
        // Expand the smaller frontier first to control branching factor
        const expandForward = forwardFrontier.size <= backwardFrontier.size;
        const currentFrontier = expandForward ? forwardFrontier : backwardFrontier;
        const nextFrontier = new Map();

        // 1. Gather nodes needing validation
        const nodesToValidate = Array.from(currentFrontier.keys())
            .filter(node => node !== start && node !== end && !humanCache.has(node));

        const validationBatches = [];
        for (let i = 0; i < nodesToValidate.length; i += 50) {
            validationBatches.push(nodesToValidate.slice(i, i + 50));
        }

        // Parallelize bulk verification
        await asyncPool(CONCURRENCY_LIMIT, validationBatches, async (batch) => {
            if (requestMade >= maxAPIRequests) return;
            await verifyHumansBulk(batch);
            requestMade++;
        });

        // 2. Filter candidates down to verified humans
        const validCandidates = Array.from(currentFrontier.entries()).filter(([curNode]) => {
            if (curNode === start || curNode === end) return true;
            return humanCache.get(curNode) === true;
        });

        let earlyReturnPath = null;

        // 3. Expand valid frontier nodes concurrently
        await asyncPool(CONCURRENCY_LIMIT, validCandidates, async ([curNode, curPath]) => {
            if (requestMade >= maxAPIRequests || earlyReturnPath) return;

            logField.innerHTML = `Log: Expanding: ${curNode} (${expandForward ? "Forward" : "Backward"})`;

            const rawNeighbors = expandForward 
                ? await fetchRawForwardLinks(curNode) 
                : await fetchRawBackwardLinks(curNode);
            requestMade++;

            for (let i = 0; i < rawNeighbors.length; i++) {
                if (earlyReturnPath) break;
                const neighbor = rawNeighbors[i];

                if (!couldBeHuman(neighbor) && neighbor !== start && neighbor !== end) {
                    continue;
                }

                const opposingVisited = expandForward ? backwardVisited : forwardVisited;

                // Intersection detected
                if (opposingVisited.has(neighbor)) {
                    let bridgeIsHuman = humanCache.get(neighbor);
                    if (bridgeIsHuman === undefined) {
                        bridgeIsHuman = await verifyIsHuman(neighbor);
                        requestMade++;
                    }

                    if (bridgeIsHuman) {
                        const pathStart = expandForward ? [...curPath, neighbor] : opposingVisited.get(neighbor);
                        const pathEnd = expandForward ? opposingVisited.get(neighbor) : [...curPath, neighbor];

                        const reversedEnd = [...pathEnd].reverse().slice(1);
                        earlyReturnPath = [...pathStart, ...reversedEnd];
                        return;
                    }
                }

                const myVisited = expandForward ? forwardVisited : backwardVisited;
                if (!myVisited.has(neighbor)) {
                    const nextPath = [...curPath, neighbor];
                    myVisited.set(neighbor, nextPath);
                    nextFrontier.set(neighbor, nextPath);
                }
            }
        });

        if (earlyReturnPath) {
            return earlyReturnPath;
        }

        if (expandForward) {
            forwardFrontier = nextFrontier;
        } else {
            backwardFrontier = nextFrontier;
        }
    }

    return "Path not found or request limit reached.";
}

function formatResult(resultJSON){
    console.log(resultJSON);
    const resultArr = Object.values(resultJSON);

    if (resultArr.length == 0){
        return ``;
    }

    let formattedResult = `${resultArr[0]}`;

    for (let i = 1; i < resultArr.length; i++){
        formattedResult += ` -> ${resultArr[i]}`;
    }

    return formattedResult;
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

        if (result == "Path not found or request limit reached."){
            throw new Error(result);
        }

        pathTag.innerText = `Path: ${formatResult(result)}`;
        statusTag.innerHTML = `Status: Success! Path built in ${((endTime - startTime) / 1000).toFixed(2)}s`;
    } catch (error) {
        console.error("Execution error:", error);
        pathTag.innerHTML = `Path: []`;
        statusTag.innerHTML = `Status: Failed!`;
    }
});