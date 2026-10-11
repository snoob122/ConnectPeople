console.log("Hello there! What you doing here?");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const startNode = document.getElementById("startNode");
const endNode = document.getElementById("endNode");
const submitBtn = document.getElementById("submitBtn");

const statusTag = document.getElementById("statusTag");
const logField = document.getElementById("logField");
const timeTag = document.getElementById("timeTag");
const requestTag = document.getElementById("requestTag");

const container = document.getElementById("pathDisplay");

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
        incRequestCounter();
        
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

let globalRequestCounter = 0;

function incRequestCounter(){
    globalRequestCounter++;

    requestTag.innerHTML = `Requests Made: <strong>${globalRequestCounter}</strong>`;
}

function resetRequestCounter(){
    globalRequestCounter = -1;

    incRequestCounter();
}

function setStatus(status){
    statusTag.innerHTML = `Status: <strong>${status}</strong>`;
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

// Fetch ALL raw outgoing links with full pagination (no filtering) - allowing for lazy verification
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

    if (requestMade >= maxAPIRequests){
        return "Request Limit Reached!";
    }else{
        return "Path Not Found!";
    }
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

function clearCard(){
    container.replaceChildren();
}

submitBtn.addEventListener("click", async () => {
    clearCard();
    setStatus("Finding");
    resetRequestCounter();
    
    const startTime = performance.now();
    
    const start = startNode.value.trim();
    const end = endNode.value.trim();

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span class="spinner"></span>`;

    statusTag.innerHTML = `Status: <strong>Searching...</strong>`;
    logField.innerHTML = `Log: Initializing...`;

    const timerInterval = setInterval(() => {
        const elapsed = (performance.now() - startTime) / 1000;
        timeTag.innerHTML = `Elapsed Time: <strong>${elapsed.toFixed(2)}s</strong>`;
    }, 50);
    
    try {

        const isValidStart = await verifyIsHuman(start);
        const isValidEnd = await verifyIsHuman(end);

        if (!isValidStart || !isValidEnd){
            setStatus(`Failed! Provided names are not available!`);
            throw new Error("Provided names do not exist!");
        }

        const result = await bidirectionalBfsShortestPath(start, end);

        if (result == "Path not found or request limit reached."){
            throw new Error(result);
        }
        renderPathCards(result);

        setStatus(`Success!`);
    } catch (error) {
        console.error("Execution error:", error);
        setStatus(`Failed! ${error}`);
    } finally{
        clearInterval(timerInterval);
        const finalElapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        timeTag.innerHTML = `Elapsed Time: <strong>${finalElapsed}s</strong>`;
        
        submitBtn.disabled = false;
        submitBtn.innerHTML = `Connect`;
    }

    logField.innerHTML = `Log: Idle`;
});

async function renderPathCards(pathArray) {
    const container = document.getElementById("pathDisplay");
    container.innerHTML = "";

    const DEFAULT_AVATAR = "https://upload.wikimedia.org/wikipedia/commons/7/7c/Profile_avatar_placeholder_large.png";

    // Batch-query all thumbnails in one single request
    const titlesParam = pathArray.map(encodeURIComponent).join("|");
    const uri = `https://en.wikipedia.org/w/api.php?action=query&titles=${titlesParam}&prop=pageimages&pithumbsize=300&format=json&origin=*&redirects=1`;

    const thumbnailMap = new Map();

    try {
        const res = await fetch(uri);
        const data = await res.json();

        if (data.query && data.query.pages) {
            const pages = Object.values(data.query.pages);
            for (const p of pages) {
                if (p.thumbnail && p.thumbnail.source) {
                    thumbnailMap.set(p.title.toLowerCase(), p.thumbnail.source);
                }
            }

            // Map normalized and redirect aliases
            if (data.query.normalized) {
                for (const norm of data.query.normalized) {
                    const src = thumbnailMap.get(norm.to.toLowerCase());
                    if (src) thumbnailMap.set(norm.from.toLowerCase(), src);
                }
            }
            if (data.query.redirects) {
                for (const red of data.query.redirects) {
                    const src = thumbnailMap.get(red.to.toLowerCase());
                    if (src) thumbnailMap.set(red.from.toLowerCase(), src);
                }
            }
        }
    } catch (e) {
        console.error("Failed to batch-fetch thumbnails:", e);
    }

    // Render cards
    for (let i = 0; i < pathArray.length; i++) {
        const title = pathArray[i];
        const imgUrl = thumbnailMap.get(title.toLowerCase()) || DEFAULT_AVATAR;
        const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;

        // Create card as an anchor tag linking to Wikipedia
        const card = document.createElement("a");
        card.className = "person-card";
        card.href = wikiUrl;
        card.target = "_blank";
        card.rel = "noopener noreferrer";
        card.innerHTML = `
            <img class="person-avatar" src="${imgUrl}" alt="${title}">
            <div class="person-name">${title}</div>
        `;
        container.appendChild(card);

        if (i < pathArray.length - 1) {
            const arrow = document.createElement("div");
            arrow.className = "arrow-separator";
            arrow.innerHTML = "→";
            container.appendChild(arrow);
        }
    }
}

const follower = document.getElementById("glowDiv");

window.addEventListener('mousemove', (e) => {
  // Update the element's position using pixel values
  follower.style.left = e.clientX + 'px';
  follower.style.top = e.clientY + 'px';
});

window.addEventListener("mousedown", () => {
    follower.classList.add("active");
});

window.addEventListener("mouseup", () => {
    follower.classList.remove("active");
});

// Debounce helper to limit API calls while typing
function debounce(fn, delay = 250) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

// Fetches 5-6 title suggestions using OpenSearch
async function fetchTextSuggestions(query) {
    if (!query) return [];
    const uri = `${BASE_URL}?action=opensearch&search=${encodeURIComponent(query)}&limit=10&namespace=0&format=json&origin=*`;
    
    try {
        const res = await fetch(uri);
        const searchData = await res.json();
        const candidateTitles = Array.isArray(searchData[1]) ? searchData[1] : [];

        if (candidateTitles.length === 0) return [];

        // Check local cache first; filter only unknown titles
        const titlesToVerify = candidateTitles.filter(t => !humanCache.has(t));

        if (titlesToVerify.length > 0) {
            const joined = titlesToVerify.map(encodeURIComponent).join('|');
            const verifyUri = `${BASE_URL}?action=${BASE_ACTION}&titles=${joined}&prop=categories&cllimit=500&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=1`;

            const catRes = await fetch(verifyUri);
            const catData = await catRes.json();

            if (catData.query && catData.query.pages) {
                const pages = Object.values(catData.query.pages);
                for (const page of pages) {
                    let isHuman = false;
                    if (page.categories) {
                        for (const cat of page.categories) {
                            const catTitle = cat.title;
                            if (catTitle.includes("Category:Living people") || 
                                /Category:\d{4} births/.test(catTitle) || 
                                /Category:\d{4} deaths/.test(catTitle)) {
                                isHuman = true;
                                break;
                            }
                        }
                    }
                    humanCache.set(page.title, isHuman);
                }

                // Handle redirects and normalization mappings
                if (catData.query.normalized) {
                    for (const norm of catData.query.normalized) {
                        humanCache.set(norm.from, humanCache.get(norm.to) || false);
                    }
                }
                if (catData.query.redirects) {
                    for (const red of catData.query.redirects) {
                        humanCache.set(red.from, humanCache.get(red.to) || false);
                    }
                }
            }
        }

        // Return only confirmed humans, up to 6 results
        return candidateTitles
            .filter(title => humanCache.get(title) === true)
            .slice(0, 6);
    } catch (err) {
        console.error("Suggestion error:", err);
        return [];
    }
}

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

        // Use mousedown to resolve before input blur fires
        item.addEventListener("mousedown", () => {
            input.value = title;
            dropdown.classList.remove("active");
        });

        dropdown.appendChild(item);
    });

    dropdown.classList.add("active");
}

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

    input.addEventListener("blur", () => {
        setTimeout(() => dropdown.classList.remove("active"), 120);
    });

    input.addEventListener("focus", () => {
        if (dropdown.children.length > 0 && input.value.trim().length >= 2) {
            dropdown.classList.add("active");
        }
    });
}

bindAutocomplete("startNode", "startSuggestions");
bindAutocomplete("endNode", "endSuggestions");