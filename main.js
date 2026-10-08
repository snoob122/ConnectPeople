const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const startNode = document.getElementById("startNode");
const endNode = document.getElementById("endNode");
const submitBtn = document.getElementById("submitBtn");

const statusTag = document.getElementById("statusTag");
const pathTag = document.getElementById("pathTag");
const debugField = document.getElementById("debugField");

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

async function fetchTitle(URI){

    let titleArr = [];
    let currentURI = URI;
    let hasMore = true;

    while (hasMore){
        const response = await fetch(currentURI);
        const dataStart = await response.json();

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
    
    }

    return titleArr;
}

// Must do preprocessing before passing patch in
async function filterHumans(humanArr){
    const humanTitles = [];

    for (let iter = 0; iter < humanArr.length; iter+=50){
        const batch = humanArr.slice(iter, iter+50).join('|');
    
        try{
            const response = await fetch(buildURIFilter(batch));
            const json = await response.json();

            if (!json.query || !json.query.pages) continue;

            const pageData = json.query.pages;
            const pageDataArr = Object.values(pageData);
        
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
                        break; // Stop checking further categories for this page
                    }
                }
        
                if (isHuman){
                    humanTitles.push(page.title);
                }
            }
        }catch (error){
            console.log("Error while filtering:", error);
        }
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

        console.log(`Exploring Node: ${curNode}`);

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

        pathTag.innerText = `${JSON.stringify(result)}`;
        statusTag.innerHTML = `Success! Path built in ${((endTime - startTime) / 1000).toFixed(2)}`
    }catch(error){
        console.log("Error:", error);
        pathTag.innerHTML = `[]`;
        statusTag.innerHTML = `Failed!`;
    }


});
