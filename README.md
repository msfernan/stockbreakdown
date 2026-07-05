# ETF holdings lookup

Type an ETF ticker, see the stocks it holds and their weights. Small Node/Express backend keeps your API key off the browser; plain HTML/JS frontend, no build step.

## Run it locally

Requires Node 18 or newer (for built-in `fetch`).

```bash
git clone https://github.com/stockbreakdown/etf-holdings-app.git
cd etf-holdings-app
npm install
cp .env.example .env
```

Open `.env` and add your Financial Modeling Prep API key:

```
FMP_API_KEY=your_actual_key_here
```

Get a free key at https://site.financialmodelingprep.com/developer/docs/dashboard. Note: FMP's ETF holdings endpoint may require a paid plan depending on their current pricing tiers — check the free plan's included endpoints if you hit a 401/403.

Then start the server:

```bash
npm start
```

Visit http://localhost:3000 and search a ticker (SPY, QQQ, VOO are good ones to try first).

## Project structure

```
etf-holdings-app/
├── server.js          Express server + /api/holdings endpoint
├── public/
│   └── index.html     Frontend (fetches from /api/holdings)
├── .env.example        Template for your API key
├── .env                 Your actual key (gitignored, not committed)
├── package.json
└── .gitignore
```

## How it works

1. Frontend sends `GET /api/holdings?ticker=SPY` to the local server.
2. Server calls FMP's `/stable/etf/holdings` and `/stable/etf/info` endpoints, merges the results, sorts by weight, and caches the response in memory for 1 hour per ticker.
3. Frontend renders the fund name, category, top-10 concentration, and a weighted list of holdings.

## Pushing this to your GitHub (stockbreakdown)

If you haven't already created the repo on GitHub, do that first (via github.com or `gh repo create`), then:

```bash
cd etf-holdings-app
git init
git add .
git commit -m "Initial commit: ETF holdings lookup"
git branch -M main
git remote add origin https://github.com/stockbreakdown/etf-holdings-app.git
git push -u origin main
```

Double check `.env` is NOT committed — `.gitignore` already excludes it, but it's worth a `git status` check before your first push since it holds your API key.

## Next steps / ideas

- Swap FMP for another provider (Polygon.io, EOD Historical Data) by editing the two `fetch` calls in `server.js` — the rest of the app doesn't need to change.
- Add a small disk or Redis cache instead of the in-memory one if you want the cache to survive restarts.
- Add a "compare two ETFs" view once single-ticker lookup feels solid.
- Deploy it (Render, Railway, Fly.io, or a VPS) once you're ready to make it public — remember to set `FMP_API_KEY` as an environment variable on whatever host you use, not in a committed file.
