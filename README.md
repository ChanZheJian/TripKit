# Roam — AI Travel Planner

A full-stack travel planner powered by Claude. Enter your destination, preferences,
and interests — get a specific, day-by-day itinerary with real restaurant names,
transit lines, costs, and local tips.

## Quick Start

### 1. Get your Anthropic API key
Sign up at https://console.anthropic.com and create an API key.

### 2. Run the proxy server

```bash
# Set your API key as an environment variable (recommended)
ANTHROPIC_API_KEY=sk-ant-... node server.js

# OR open server.js and paste your key on line 7
node server.js
```

You'll see:
```
✈  Travel Planner running at http://localhost:3001
```

### 3. Open the website
Just open `index.html` in your browser — or visit http://localhost:3001
(the server also serves the HTML file).

---

## How it works

```
Browser (index.html)
  └─ POST /api/chat  ──►  server.js (Node proxy)
                              └─ POST api.anthropic.com/v1/messages
                                      ↓
                          JSON itinerary  ◄──────────────────┘
```

The proxy:
- Keeps your API key secret (never exposed to the browser)
- Adds the required Anthropic headers
- Sets CORS headers so the browser can talk to it

---

## Deploy to production

### Vercel (recommended)
1. Create `api/chat.js` (Vercel serverless function) with the proxy logic from server.js
2. Add `ANTHROPIC_API_KEY` in Vercel environment variables
3. Deploy — your frontend calls `/api/chat` (same origin, no CORS needed)

### Railway / Render
Deploy the whole folder. Set `ANTHROPIC_API_KEY` as an env var in the dashboard.

### Cloudflare Workers
Port server.js to a Worker (fetch handler). Store the key as a secret via `wrangler secret put`.

---

## Files
```
travel-planner/
├── index.html   — the full website (self-contained HTML/CSS/JS)
├── server.js    — Node.js proxy server (no dependencies, built-in modules only)
└── README.md    — this file
```

No npm install needed. Runs on Node.js 14+.
