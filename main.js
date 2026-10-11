console.log("Hello there! What you doing here?");

// --- DOM Elements ---
const domElements = {
    startInput: document.getElementById("startNode"),
    endInput: document.getElementById("endNode"),
    submitBtn: document.getElementById("submitBtn"),
    statusTag: document.getElementById("statusTag"),
    logField: document.getElementById("logField"),
    timeTag: document.getElementById("timeTag"),
    requestTag: document.getElementById("requestTag"),
    pathContainer: document.getElementById("pathDisplay"),
    followerGlow: document.getElementById("glowDiv")
};

// --- Constants & State ---
const API = {
    BASE_URL: "https://en.wikipedia.org/w/api.php",
    DEFAULT_PARAMS: `action=query&format=json&origin=*&redirects=1`
};

// Regex to aggressively filter out obvious non-human Wikipedia titles before making API calls
const NON_HUMAN_PATTERN = /\b(album|song|film|band|soundtrack|season|discography|tour|awards?|records?|university|county|school|dynasty|battle|treaty|elections?|presidency|administration|cabinet|politics|history|geography|discography|videography|list of)\b|\d{4}|^\d+$|\(.*(album\vert{}film\vert{}song\vert{}single\vert{}band\vert{}soundtrack\vert{}season\vert{}episode\vert{}TV series\vert{}novel\vert{}EP\vert{}company\vert{}record label\vert{}musical).*\)$/i;

// AIMD (Additive Increase / Multiplicative Decrease) state for dynamic concurrency control
const aimdState = { limit: 8, max: 20 };
const humanCache = new Map();
let globalRequestCounter = 0;

// --- Utility Functions ---

// Pauses execution for a specified number of milliseconds
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Updates the UI tracker for API requests made
function updateRequestCounter(reset = false) {
    globalRequestCounter = reset ? 0 : globalRequestCounter + 1;
    domElements.requestTag.innerHTML = `Requests Made: <strong>${globalRequestCounter}</strong>`;
}

// Updates the UI status text
function setStatus(statusMessage) {
    domElements.statusTag.innerHTML = `Status: <strong>${statusMessage}</strong>`;
}

// Checks if a specific Wikipedia category string indicates a human entity
function isPersonCategory(title) {
    return title.includes("Category:Living people") || 
           /Category:\d{4} births/.test(title) || 
           /Category:\d{4} deaths/.test(title);
}

// Scans an array of Wikipedia categories for human indicators
function checkCategoriesForHuman(categories) {
    if (!categories) return false;
    return categories.some(cat => isPersonCategory(cat.title));
}

// Quickly filters out obvious non-human titles using Regex
function couldBeHuman(title) {
    return (title && typeof title === "string") ? !NON_HUMAN_PATTERN.test(title) : false;
}

// --- Network & Concurrency ---

// Fetches data from MediaWiki, featuring AIMD congestion control to maximize throughput
async function fetchWithRetry(url, maxRetries = 6, initialDelay = 2000) {
    let delay = initialDelay;
    
    for (let i = 0; i < maxRetries; i++) {
        const response = await fetch(url);
        updateRequestCounter();
        
        if (response.ok) {
            // Additive Increase: Gradually scale up concurrency on successful requests (+1 thread per 10 successes)
            aimdState.limit = Math.min(aimdState.max, aimdState.limit + 0.1);
            return response.json();
        }
        
        if (response.status === 429) {
            console.warn(`Rate limit hit (429). Retrying in ${delay}ms...`);
            // Multiplicative Decrease: Instantly halve concurrency to shed load and avoid cascading timeouts
            aimdState.limit = Math.max(1, Math.floor(aimdState.limit / 2));
            await sleep(delay);
            delay *= 2; // Exponential backoff for the retry delay
            continue;
        }
        throw new Error(`HTTP Error: ${response.status}`);
    }
    throw new Error("Max retries reached due to rate limiting.");
}

// Executes a set of promises concurrently, dynamically throttling based on aimdState
async function asyncPool(items, iteratorFn) {
    const results = [];
    const executing = new Set();

    for (const item of items) {
        const promise = Promise.resolve().then(() => iteratorFn(item));
        results.push(promise);
        executing.add(promise);

        const clean = () => executing.delete(promise);
        promise.then(clean, clean);

        // Dynamically throttle: Promise.race pauses the loop until at least one active request finishes
        while (executing.size >= Math.floor(aimdState.limit)) {
            await Promise.race(executing);
        }
    }
    return Promise.all(results);
}

// --- Wikipedia API Interactions ---

// Makes a single Wikipedia API call to check a title's categories, caching the result
async function verifyIsHuman(title) {
    if (humanCache.has(title)) return humanCache.get(title);

    const uri = `${API.BASE_URL}?${API.DEFAULT_PARAMS}&titles=${encodeURIComponent(title)}&prop=categories&cllimit=500`;

    try {
        const data = await fetchWithRetry(uri);
        const page = data.query?.pages ? Object.values(data.query.pages)[0] : null;
        const isHuman = page ? checkCategoriesForHuman(page.categories) : false;
        
        humanCache.set(title, isHuman);
        return isHuman;
    } catch (err) {
        console.error("Validation error for:", title, err);
        return false;
    }
}

// Groups unverified titles into chunks of 50 to minimize API requests during validation
async function verifyHumansBulk(titles) {
    const unverified = titles.filter(t => !humanCache.has(t));
    if (unverified.length === 0) return;

    for (let i = 0; i < unverified.length; i += 50) {
        const batch = unverified.slice(i, i + 50);
        const joinedTitles = batch.map(encodeURIComponent).join('|');
        const uri = `${API.BASE_URL}?${API.DEFAULT_PARAMS}&titles=${joinedTitles}&prop=categories&cllimit=500`;

        try {
            const data = await fetchWithRetry(uri);
            if (!data.query?.pages) continue;

            for (const page of Object.values(data.query.pages)) {
                humanCache.set(page.title, checkCategoriesForHuman(page.categories));
            }
        } catch (err) {
            console.error("Bulk validation error:", err);
        }
    }
}

// Fetches all incoming or outgoing links for a given title, handling MediaWiki's pagination
async function fetchLinks(title, isForward) {
    const encTitle = encodeURIComponent(title);
    const prop = isForward ? 'links' : 'linkshere';
    const limitProp = isForward ? 'pllimit' : 'lhlimit';
    const nsProp = isForward ? 'plnamespace' : 'lhnamespace';
    const contProp = isForward ? 'plcontinue' : 'lhcontinue';

    let uri = `${API.BASE_URL}?${API.DEFAULT_PARAMS}&titles=${encTitle}&prop=${prop}&${limitProp}=500&${nsProp}=0`;
    const results = [];

    while (uri) {
        try {
            const data = await fetchWithRetry(uri);
            if (!data.query?.pages) break;

            const page = Object.values(data.query.pages)[0];
            const items = page[prop];
            if (items) {
                for (const item of items) results.push(item.title);
            }

            // Handle pagination: Wikipedia returns a 'continue' token if there are more than 500 links
            if (data.continue?.[contProp]) {
                const continueToken = encodeURIComponent(data.continue[contProp]);
                uri = `${API.BASE_URL}?${API.DEFAULT_PARAMS}&titles=${encTitle}&prop=${prop}&${limitProp}=500&${nsProp}=0&${contProp}=${continueToken}`;
                await sleep(50);
            } else {
                uri = null;
            }
        } catch (err) {
            console.error(`Error fetching ${isForward ? 'outgoing' : 'inbound'} links:`, err);
            break;
        }
    }
    return results;
}

// --- Core Algorithm ---

// Finds the shortest path using a Bidirectional Breadth-First Search to radically reduce the branching factor
async function bidirectionalBfsShortestPath(start, end) {
    if (start === end) return [start];

    humanCache.set(start, true);
    humanCache.set(end, true);

    let forwardFrontier = new Map([[start, [start]]]);
    let backwardFrontier = new Map([[end, [end]]]);
    const forwardVisited = new Map([[start, [start]]]);
    const backwardVisited = new Map([[end, [end]]]);

    const maxAPIRequests = 2000;
    let requestMade = 0;

    while (forwardFrontier.size > 0 && backwardFrontier.size > 0 && requestMade < maxAPIRequests) {
        // Optimization: Always expand the smaller frontier to control exponential growth
        const expandForward = forwardFrontier.size <= backwardFrontier.size;
        const currentFrontier = expandForward ? forwardFrontier : backwardFrontier;
        const nextFrontier = new Map();

        // 1. Verify unverified nodes in bulk
        const unverifiedNodes = Array.from(currentFrontier.keys()).filter(node => node !== start && node !== end && !humanCache.has(node));
        const validationBatches = [];
        for (let i = 0; i < unverifiedNodes.length; i += 50) {
            validationBatches.push(unverifiedNodes.slice(i, i + 50));
        }

        await asyncPool(validationBatches, async (batch) => {
            if (requestMade >= maxAPIRequests) return;
            await verifyHumansBulk(batch);
            requestMade++;
        });

        // 2. Expand only verified human nodes
        const verifiedCandidates = Array.from(currentFrontier.entries()).filter(([node]) => humanCache.get(node) === true);
        let earlyReturnPath = null;

        await asyncPool(verifiedCandidates, async ([curNode, curPath]) => {
            if (requestMade >= maxAPIRequests || earlyReturnPath) return;

            domElements.logField.innerHTML = `Log: Expanding: ${curNode} (${expandForward ? "Forward" : "Backward"})`;
            const rawNeighbors = await fetchLinks(curNode, expandForward);
            requestMade++;

            for (const neighbor of rawNeighbors) {
                if (earlyReturnPath) break;
                if (!couldBeHuman(neighbor) && neighbor !== start && neighbor !== end) continue;

                const opposingVisited = expandForward ? backwardVisited : forwardVisited;

                // Intersection detected: A node from one side connected to a node already visited by the other side
                if (opposingVisited.has(neighbor)) {
                    let isBridgeHuman = humanCache.get(neighbor);
                    if (isBridgeHuman === undefined) {
                        isBridgeHuman = await verifyIsHuman(neighbor);
                        requestMade++;
                    }

                    if (isBridgeHuman) {
                        const pathStart = expandForward ? [...curPath, neighbor] : opposingVisited.get(neighbor);
                        const pathEnd = expandForward ? opposingVisited.get(neighbor) : [...curPath, neighbor];
                        
                        // Merge the paths. If expanding forward, pathEnd is reversed and the duplicate bridge node (index 0) is sliced off.
                        earlyReturnPath = [...pathStart, ...[...pathEnd].reverse().slice(1)];
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

        if (earlyReturnPath) return earlyReturnPath;

        if (expandForward) {
            forwardFrontier = nextFrontier;
        } else {
            backwardFrontier = nextFrontier;
        }
    }

    return requestMade >= maxAPIRequests ? "Request Limit Reached!" : "Path Not Found!";
}

// --- UI & Rendering ---

// Fetches thumbnails in bulk and generates the visual UI cards for the final path
async function renderPathCards(pathArray) {
    domElements.pathContainer.innerHTML = "";
    const DEFAULT_AVATAR = "https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png";
    const titlesParam = pathArray.map(encodeURIComponent).join("|");
    const uri = `${API.BASE_URL}?action=query&titles=${titlesParam}&prop=pageimages&pithumbsize=300&format=json&origin=*&redirects=1`;
    const thumbnailMap = new Map();

    try {
        const res = await fetch(uri);
        const data = await res.json();

        if (data.query?.pages) {
            for (const p of Object.values(data.query.pages)) {
                if (p.thumbnail?.source) thumbnailMap.set(p.title.toLowerCase(), p.thumbnail.source);
            }
            
            // Map thumbnails across redirects and API normalizations (e.g., lowercase to Title Case)
            ['normalized', 'redirects'].forEach(type => {
                if (data.query[type]) {
                    for (const item of data.query[type]) {
                        const src = thumbnailMap.get(item.to.toLowerCase());
                        if (src) thumbnailMap.set(item.from.toLowerCase(), src);
                    }
                }
            });
        }
    } catch (e) {
        console.error("Failed to batch-fetch thumbnails:", e);
    }

    pathArray.forEach((title, index) => {
        const imgUrl = thumbnailMap.get(title.toLowerCase()) || DEFAULT_AVATAR;
        const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;

        const card = document.createElement("a");
        card.className = "person-card";
        card.href = wikiUrl;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
        card.innerHTML = `<img class="person-avatar" src="${imgUrl}" alt="${title}"><div class="person-name">${title}</div>`;
        domElements.pathContainer.appendChild(card);

        if (index < pathArray.length - 1) {
            const arrow = document.createElement("div");
            arrow.className = "arrow-separator";
            arrow.innerHTML = "→";
            domElements.pathContainer.appendChild(arrow);
        }
    });
}

// Orchestrates the search process, handling UI states, validation, and algorithm execution
async function handleSearchSubmit() {
    domElements.pathContainer.replaceChildren();
    setStatus("Finding");
    updateRequestCounter(true);
    
    const startTime = performance.now();
    const start = domElements.startInput.value.trim();
    const end = domElements.endInput.value.trim();

    domElements.submitBtn.disabled = true;
    domElements.submitBtn.innerHTML = `<span class="spinner"></span>`;
    setStatus("Searching...");
    domElements.logField.innerHTML = `Log: Initializing...`;

    const timerInterval = setInterval(() => {
        domElements.timeTag.innerHTML = `Elapsed Time: <strong>${((performance.now() - startTime) / 1000).toFixed(2)}s</strong>`;
    }, 50);
    
    try {
        const [isValidStart, isValidEnd] = await Promise.all([verifyIsHuman(start), verifyIsHuman(end)]);

        if (!isValidStart || !isValidEnd) {
            throw new Error("Provided names do not exist or are not valid humans!");
        }

        const result = await bidirectionalBfsShortestPath(start, end);
        if (typeof result === "string") throw new Error(result);
        
        await renderPathCards(result);
        setStatus("Success!");
    } catch (error) {
        console.error("Execution error:", error);
        setStatus(`Failed! ${error.message}`);
    } finally {
        clearInterval(timerInterval);
        domElements.timeTag.innerHTML = `Elapsed Time: <strong>${((performance.now() - startTime) / 1000).toFixed(2)}s</strong>`;
        domElements.submitBtn.disabled = false;
        domElements.submitBtn.innerHTML = `Connect`;
        domElements.logField.innerHTML = `Log: Idle`;
    }
}

domElements.submitBtn.addEventListener("click", handleSearchSubmit);

// --- Visual Effects & Autocomplete ---

window.addEventListener('mousemove', (e) => {
    domElements.followerGlow.style.left = `${e.clientX}px`;
    domElements.followerGlow.style.top = `${e.clientY}px`;
});

window.addEventListener("mousedown", () => domElements.followerGlow.classList.add("active"));
window.addEventListener("mouseup", () => domElements.followerGlow.classList.remove("active"));

// Delays function execution until after a specified wait time to prevent spamming the API on every keystroke
function debounce(fn, delay = 250) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// Queries the OpenSearch API for autocomplete candidates and filters them to verified humans
async function fetchTextSuggestions(query) {
    if (!query) return [];
    const uri = `${API.BASE_URL}?action=opensearch&search=${encodeURIComponent(query)}&limit=10&namespace=0&format=json&origin=*`;
    
    try {
        const res = await fetch(uri);
        const searchData = await res.json();
        const candidateTitles = Array.isArray(searchData[1]) ? searchData[1] : [];
        if (candidateTitles.length === 0) return [];

        const titlesToVerify = candidateTitles.filter(t => !humanCache.has(t));
        if (titlesToVerify.length > 0) {
            const joined = titlesToVerify.map(encodeURIComponent).join('|');
            const verifyUri = `${API.BASE_URL}?${API.DEFAULT_PARAMS}&titles=${joined}&prop=categories&cllimit=500`;

            const catRes = await fetch(verifyUri);
            const catData = await catRes.json();

            if (catData.query?.pages) {
                for (const page of Object.values(catData.query.pages)) {
                    humanCache.set(page.title, checkCategoriesForHuman(page.categories));
                }
                
                ['normalized', 'redirects'].forEach(type => {
                    if (catData.query[type]) {
                        for (const item of catData.query[type]) {
                            humanCache.set(item.from, humanCache.get(item.to) || false);
                        }
                    }
                });
            }
        }
        return candidateTitles.filter(title => humanCache.get(title) === true).slice(0, 6);
    } catch (err) {
        console.error("Suggestion error:", err);
        return [];
    }
}

// Renders the autocomplete dropdown list
function renderTextSuggestions(titles, dropdown, input) {
    dropdown.innerHTML = "";
    if (titles.length === 0) {
        dropdown.classList.remove("active");
        return;
    }

    titles.forEach(title => {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        item.textContent = title;
        item.addEventListener("mousedown", () => {
            input.value = title;
            dropdown.classList.remove("active");
        });
        dropdown.appendChild(item);
    });
    dropdown.classList.add("active");
}

// Attaches event listeners for input, focus, and blur to handle the autocomplete UI logic
function bindAutocomplete(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);

    input.addEventListener("input", debounce(async (e) => {
        const query = e.target.value.trim();
        if (query.length < 2) {
            dropdown.classList.remove("active");
            return;
        }
        const titles = await fetchTextSuggestions(query);
        renderTextSuggestions(titles, dropdown, input);
    }, 250));

    input.addEventListener("blur", () => setTimeout(() => dropdown.classList.remove("active"), 120));
    input.addEventListener("focus", () => {
        if (dropdown.children.length > 0 && input.value.trim().length >= 2) dropdown.classList.add("active");
    });
}

bindAutocomplete("startNode", "startSuggestions");
bindAutocomplete("endNode", "endSuggestions");