# ConnectPeople

A client-side web application that calculates the shortest connection path between any two historical or contemporary figures on Wikipedia using a bidirectional breadth-first search (BFS) algorithm.

---

## Overview

Wikipedia can be modeled as a directed graph where articles are nodes and hyperlinks are directed edges. Finding the shortest path between high-degree nodes (such as world leaders or celebrities) often results in an exponential explosion of outgoing links.

**ConnectPeople** solves this by running an optimized bidirectional search directly in the browser while filtering out non-human Wikipedia entities and keeping HTTP request volumes strictly under MediaWiki's rate limits.

---

## Features

- **Bidirectional Breadth-First Search (BFS):** Expands the smaller frontier at each step between the start person (outgoing links via `prop=links`) and the target person (inbound links via `prop=linkshere`) to minimize graph branching.
- **Strict Directed Graph Separation:** Distinguishes between outgoing and incoming hyperlinks, preventing invalid reverse-directed traversals.
- **Lazy Human Verification:** Uses local regex heuristics (`NON_HUMAN_REGEX`) to discard non-person candidate links instantly, validating category membership (`Category:Living people`, `Category:* births`, `Category:* deaths`) only when dequeuing nodes for expansion.
- **Bulk MediaWiki API Validation:** Batches up to 50 candidate entities into a single category query (`prop=categories&cllimit=500`) to maximize query density per HTTP round trip.
- **Concurrency & Rate Limit Protection:**
  - Employs an asynchronous worker pool (`asyncPool`) capped at 2 concurrent requests to avoid HTTP 429 penalties.
  - Implements exponential backoff retries via `fetchWithRetry`.
- **Dynamic Result Cards:** Queries Wikipedia's `prop=pageimages` in a single batch to render avatar cards with names and direct Wikipedia links for every person in the resolved path.
- **Interactive Dark UI:** Modern glassmorphism layout with live execution telemetry (status, elapsed time, request counter) and an ambient cursor follower that illuminates an overlaid dot grid.

---

## Project Structure

```text
ConnectPeople/
├── index.html        # Main interface with glassmorphism layout and follower elements
├── style.css         # Styling, layout, animations, and blend-mode lighting effects
├── main.js           # Bidirectional BFS graph solver and Wikipedia API integration
└── Resources/
    └── two-arrows-white.png  # Direction indicator asset
```

---

## Getting Started

Because the application is entirely client-side and interacts with Wikipedia's public CORS-enabled API (`origin=*`), no backend server, database, or API keys are required.

### Prerequisites

A modern web browser with JavaScript ES6+ support (Chrome, Firefox, Safari, Edge).

### Installation & Running

1. Clone the repository:
   ```bash
   git clone https://github.com/snoob122/ConnectPeople.git
   cd ConnectPeople
   ```

2. Open the application:
   - Double-click or open `index.html` directly in any web browser, or
   - Serve using a lightweight local development server (e.g. VS Code Live Server or `npx serve`):
     ```bash
     npx serve .
     ```

---

## Usage

1. Enter a starting name in the **Start Person** input (e.g., `Beyonce`, `John Cena`).
2. Enter a target name in the **Target Person** input (e.g., `Trump`, `Ho Chi Minh`).
3. Click **Connect**.
4. Monitor the real-time request counter, elapsed time timer, and activity log.
5. Click any card in the generated path to open that person's Wikipedia page in a new tab.

---

## Author

- **beanDaDev** ([GitHub Profile](https://github.com/snoob122))
