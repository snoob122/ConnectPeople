const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const startNode = document.getElementById("startNode");
const endNode = document.getElementById("endNode");
const submitBtn = document.getElementById("submitBtn");

const statusTag = document.getElementById("statusTag");
const pathTag = document.getElementById("pathTag");
const logField = document.getElementById("logField");

// URI Variables
const BASE_URL = "https://en.wikipedia.org/w/api.php";
const BASE_ACTION = "query";
const BASE_PROP = "links";
const BASE_PLLIMIT = 500;
const BASE_FORMAT = "json";
const BASE_ORIGIN = "*";
const BASE_PLNAMESPACE = 0;
const BASE_REDIRECTS = 1;

function buildURI(titles){
    // Same URI as the one used in the API documentation
    // https://en.wikipedia.org/w/api.php?action=query&titles=Albert_Einstein&prop=links&pllimit=500&format=json&origin=*&plnamespace=0&redirects=1
    if (typeof(titles) != "string") return "Invalid titles!";

    titles = encodeURIComponent(titles);

    const uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${titles}&prop=${BASE_PROP}&pllimit=${BASE_PLLIMIT}&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&plnamespace=${BASE_PLNAMESPACE}&redirects=${BASE_REDIRECTS}`;

    return uri;
}

function buildURIFilter(titles){
    const FILTER_PROP = "categories";
    const FILTER_CLLIMIT = 500;

    titles = encodeURIComponent(titles);

    const uri = `${BASE_URL}?action=${BASE_ACTION}&titles=${titles}&prop=${FILTER_PROP}&cllimit=${FILTER_CLLIMIT}&format=${BASE_FORMAT}&origin=${BASE_ORIGIN}&redirects=${BASE_REDIRECTS}`;

    return uri;
}

async function fetchWithRetry(url, maxRetries = 3, initialDelay = 1000) {
    let delay = initialDelay;
    
    for (let i = 0; i < maxRetries; i++) {
        const response = await fetch(url);
        
        // If successful, parse and return the JSON
        if (response.ok) {
            return response.json();
        }
        
        // If rate limited, wait and try again
        if (response.status === 429) {
            console.warn(`Rate limit hit (429). Retrying in ${delay}ms...`);
            await sleep(delay);
            delay *= 2; // Double the wait time on each subsequent failure
            continue;
        }
        
        // Throw any other unhandled HTTP errors
        throw new Error(`HTTP Error: ${response.status}`);
    }
    
    throw new Error("Max retries reached due to rate limiting.");
}

async function fetchTitle(URI){

    let titleArr = [];
    let currentURI = URI;
    let hasMore = true;

    while (hasMore){
        try{
            const dataStart = await fetchWithRetry(currentURI);

            if (!dataStart.query || !dataStart.query.pages){
                return titleArr;
            }
        
            const pages = dataStart.query.pages;
            const pageData = Object.values(pages)[0];
        
            if (pageData.links) {
                const rawTitle = pageData.links;
            
                for (let i = 0; i < rawTitle.length; i++){
                    titleArr.push(rawTitle[i].title);
                }
            }

            if (dataStart.continue && dataStart.continue.plcontinue){
                currentURI = `${URI}&plcontinue=${encodeURIComponent(dataStart.continue.plcontinue)}`;
            }else{
                hasMore = false;
            }
        } catch (error){
            console.error("Error fetching title links:", error);
            break;
        }
    }

    return titleArr;
}

// Must do preprocessing before passing patch in
async function filterHumans(humanArr){
    const humanTitles = [];
    
    // Set how many batch requests can run simultaneously
    const CONCURRENCY_LIMIT = 3; 

    for (let iter = 0; iter < humanArr.length; iter += (50 * CONCURRENCY_LIMIT)){
        const batchPromises = [];

        for (let i = 0; i < CONCURRENCY_LIMIT; i++) {
            const startIndex = iter + (i * 50);
            if (startIndex >= humanArr.length) break;

            const batch = humanArr.slice(startIndex, startIndex + 50).join('|');
            const uri = buildURIFilter(batch);

            batchPromises.push(
                fetchWithRetry(uri).catch(error => {
                    console.error("Batch fetch error:", error);
                    return null; 
                })
            );
        }

        // Await this specific chunk of 5 requests
        const results = await Promise.all(batchPromises);

        // Process the JSON payloads synchronously
        for (let k = 0; k < results.length; k++){
            const json = results[k];

            if (!json || !json.query || !json.query.pages) continue;

            const pageDataArr = Object.values(json.query.pages);
            
            for (let i = 0; i < pageDataArr.length; i++){
                const page = pageDataArr[i];
        
                if (!page.categories) continue;
        
                let isHuman = false;
        
                for (let j = 0; j < page.categories.length; j++){
                    const categoryTitle = page.categories[j].title;
        
                    if (categoryTitle.includes("Category:Living people") || 
                        /Category:\d{4} births/.test(categoryTitle) || 
                        /Category:\d{4} deaths/.test(categoryTitle)) {
                        isHuman = true;
                        break; 
                    }
                }
        
                if (isHuman){
                    humanTitles.push(page.title);
                }
            }
        }
        
        // Pause execution before firing the next chunk of 3 requests
        await sleep(200);
    }
    
    return humanTitles;
}

async function bfsShortestPath(start, end){
    const queue = [[start]];
    const visited = new Set();
    visited.add(start);

    let maxAPIRequests = 150;
    let requestMade = 0;

    while (queue.length > 0 && requestMade < maxAPIRequests){
        const curPath = queue.shift();

        const curNode = curPath[curPath.length - 1];

        logField.innerHTML = `Log: Exploring Node: ${curNode}`;

        const linksData = await fetchTitle(buildURI(curNode));
        requestMade++;

        const humanNeighbors = await filterHumans(linksData);

        for (let i = 0; i < humanNeighbors.length; i++){
            const neighbor = humanNeighbors[i];

            if (neighbor === end) {
                return [...curPath, neighbor];
            }

            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push([...curPath, neighbor]);
            }
        }

        await sleep(200); 
    }

    return "Path not found or request limit reached.";
}

submitBtn.addEventListener("click", async () => {
    // Get Start Time
    const startTime = performance.now();

    const start = startNode.value;
    const end = endNode.value;

    console.log(buildURI(start));

    try{
        const result = await bfsShortestPath(start, end);

        // Get End Time
        const endTime = performance.now();

        pathTag.innerText = `Path: ${JSON.stringify(result)}`;
        statusTag.innerHTML = `Status: Success! Path built in ${((endTime - startTime) / 1000).toFixed(2)}`
    }catch(error){
        console.log("Error:", error);
        pathTag.innerHTML = `Path: []`;
        statusTag.innerHTML = `Status: Failed!`;
    }
});
