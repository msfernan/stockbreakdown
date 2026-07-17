# ETF holdings lookup

Type an ETF ticker, see the stocks it holds and their weights. Small Node/Express backend pulls from Yahoo Finance's unofficial quoteSummary API (no key required); plain HTML/JS frontend, no build step.

## Run it locally

Requires Node 18 or newer (for built-in `fetch`).

```bash
git clone https://github.com/stockbreakdown/etf-holdings-app.git
cd etf-holdings-app
npm install
```

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
2. Server obtains a Yahoo session cookie + crumb (Yahoo requires this for its quoteSummary API), then calls `query1.finance.yahoo.com/v10/finance/quoteSummary` with the `topHoldings`, `quoteType`, and `fundProfile` modules, sorts by weight, and caches the response in memory for 1 hour per ticker.
3. Frontend renders the fund name, category, top-10 concentration, and a weighted list of holdings.

Note: this is Yahoo's unofficial, undocumented endpoint — it's free and requires no signup, but it isn't a supported public API and could change or start rate-limiting without notice.

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

## Portfolio & concentration

Below the single-ticker lookup, you can build a portfolio:

1. Add positions — pick ETF or Stock, enter a ticker and a dollar amount, click Add.
2. Click **Save portfolio** — writes to `data/portfolio.json` locally (gitignored, since it's your personal holdings).
3. Click **View stock concentration** — the server looks through every ETF position to its actual holdings, multiplies each holding's weight by your dollar amount in that ETF, and sums everything (including direct stock positions) by underlying ticker. So if you hold both SPY and QQQ, your AAPL exposure from both gets combined into one number.

The result shows your top aggregate stock exposures as a % of total portfolio value, and which position(s) each one flowed in through (e.g. "via SPY, QQQ" or "direct").

Notes:
- This is a *single* saved portfolio (not multi-user, no accounts) — fine for personal local use.
- The concentration calc uses each ETF's full holdings list (not just top 15), so numbers may not sum to exactly 100% if Yahoo's data excludes cash or very small residual positions.
- Every "View stock concentration" click re-fetches ETF holdings not already cached (1hr cache), so it may take a few seconds the first time for a given ETF.

## Next steps / ideas

- Swap Yahoo for an official paid provider (Financial Modeling Prep, Polygon.io, EOD Historical Data) by editing `fetchEtfHoldings` in `server.js` if you need a supported SLA.
- Add a small disk or Redis cache instead of the in-memory one if you want the cache to survive restarts.
- Add a "compare two ETFs" view once single-ticker lookup feels solid.
- Deploy it (Render, Railway, Fly.io, or a VPS) once you're ready to make it public.
