require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const ExcelJS = require('exceljs');

const app = express();
const PORT = process.env.PORT || 3000;
const PORTFOLIO_FILE = path.join(__dirname, 'data', 'portfolio.json');
const USER_AGENT = 'Mozilla/5.0';

// Simple in-memory cache so repeated lookups don't burn API calls.
// Key: ticker, Value: { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, holdings don't change intraday

// Prices move constantly, so this cache is short -- just enough to dedupe
// bursts of requests for the same ticker within a single portfolio calc.
const priceCache = new Map();
const PRICE_CACHE_TTL_MS = 30 * 1000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '15mb' }));

// Yahoo's quoteSummary endpoint requires a session cookie + crumb (CSRF token).
// Fetch once and reuse until Yahoo rejects it, then refresh.
let yahooSession = null;

async function fetchYahooSession() {
  const consentResp = await fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': USER_AGENT }
  });
  const cookie = consentResp.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

  const crumbResp = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': USER_AGENT, Cookie: cookie }
  });
  const crumb = await crumbResp.text();

  yahooSession = { cookie, crumb };
  return yahooSession;
}

async function fetchQuoteSummary(ticker, modules) {
  // Yahoo uses a dash for share classes (BRK-B), not the dot most brokers
  // and other data providers use (BRK.B).
  const yahooTicker = ticker.replace(/\./g, '-');
  const session = yahooSession || (await fetchYahooSession());
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`;
  let resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Cookie: session.cookie } });

  if (resp.status === 401) {
    // Crumb likely expired; refresh once and retry.
    const fresh = await fetchYahooSession();
    const retryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=${modules}&crumb=${encodeURIComponent(fresh.crumb)}`;
    resp = await fetch(retryUrl, { headers: { 'User-Agent': USER_AGENT, Cookie: fresh.cookie } });
  }

  return resp;
}

// ---- Live price, shared by /api/quote and the portfolio concentration calc ----
async function fetchQuotePrice(ticker) {
  const cached = priceCache.get(ticker);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.price;
  }

  const resp = await fetchQuoteSummary(ticker, 'price');
  if (!resp.ok) {
    const err = new Error(`Yahoo Finance returned status ${resp.status} for ticker ${ticker}.`);
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  const raw = await resp.json();
  const price = raw?.quoteSummary?.result?.[0]?.price?.regularMarketPrice?.raw;

  if (typeof price !== 'number') {
    const err = new Error(`No price data for "${ticker}". Check the ticker is correct.`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  priceCache.set(ticker, { price, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
  return price;
}

// ---- ETF vs. stock classification, used to auto-tag imported positions ----
// Mutual funds (e.g. VFTAX) expose the same topHoldings look-through data as
// ETFs via Yahoo, so both get tagged 'etf' here to trigger that look-through.
async function fetchQuoteType(ticker) {
  const resp = await fetchQuoteSummary(ticker, 'quoteType');
  if (!resp.ok) return 'stock';
  const raw = await resp.json();
  const quoteType = raw?.quoteSummary?.result?.[0]?.quoteType?.quoteType;
  return quoteType === 'ETF' || quoteType === 'MUTUALFUND' ? 'etf' : 'stock';
}

// ---- Core Yahoo fetch, shared by the single-ticker endpoint and portfolio calc ----
async function fetchEtfHoldings(ticker) {
  const cached = cache.get(ticker);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const resp = await fetchQuoteSummary(ticker, 'topHoldings,quoteType,fundProfile');

  if (!resp.ok) {
    const err = new Error(`Yahoo Finance returned status ${resp.status} for ticker ${ticker}.`);
    err.code = 'UPSTREAM_ERROR';
    throw err;
  }

  const raw = await resp.json();
  const result = raw?.quoteSummary?.result?.[0];
  const holdingsRaw = result?.topHoldings?.holdings;

  if (!Array.isArray(holdingsRaw) || holdingsRaw.length === 0) {
    const err = new Error(`No holdings data for "${ticker}". Check the ticker is a real ETF.`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  const fundName = result.quoteType?.longName || ticker;
  const category = result.fundProfile?.categoryName || '';

  // Full, untruncated list -- used for accurate portfolio aggregation.
  // The /api/holdings endpoint below truncates to top 15 for display only.
  const holdings = holdingsRaw
    .map(h => ({
      t: h.symbol || '',
      n: h.holdingName || h.symbol || '',
      w: (h.holdingPercent?.raw ?? 0) * 100
    }))
    .filter(h => h.t)
    .sort((a, b) => b.w - a.w);

  const payload = { symbol: ticker, name: fundName, category, holdings };
  cache.set(ticker, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return payload;
}

function errorStatusFor(err) {
  if (err.code === 'UPSTREAM_ERROR') return 502;
  if (err.code === 'NOT_FOUND') return 404;
  return 500;
}

// ---- Single ETF lookup (existing feature) ----
app.get('/api/holdings', async (req, res) => {
  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: 'Missing ticker', message: 'Provide a ticker, e.g. /api/holdings?ticker=SPY' });
  }
  try {
    const data = await fetchEtfHoldings(ticker);
    res.json({ ...data, holdings: data.holdings.slice(0, 15) });
  } catch (err) {
    console.error('Error fetching holdings:', err.message);
    res.status(errorStatusFor(err)).json({ error: err.code || 'Server error', message: err.message });
  }
});

// ---- Live quote lookup (used when adding a position, to convert $ -> shares) ----
app.get('/api/quote', async (req, res) => {
  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) {
    return res.status(400).json({ error: 'Missing ticker', message: 'Provide a ticker, e.g. /api/quote?ticker=AAPL' });
  }
  try {
    const price = await fetchQuotePrice(ticker);
    res.json({ symbol: ticker, price });
  } catch (err) {
    console.error('Error fetching quote:', err.message);
    res.status(errorStatusFor(err)).json({ error: err.code || 'Server error', message: err.message });
  }
});

// ---- Broker file import ----
// Parses an E*TRADE brokerage "PortfolioDownload.csv" positions export.
// The file has a couple of unrelated header blocks before the real table, so
// we find the row that actually starts "Symbol," and use its own header
// names to find columns, rather than assuming fixed positions.
function parseBrokerageCsv(text) {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => l.startsWith('Symbol,') && l.includes('Quantity'));
  if (headerIdx === -1) {
    throw new Error('Could not find a "Symbol / Quantity" positions table in this CSV.');
  }

  const header = lines[headerIdx].split(',');
  const symbolIdx = header.indexOf('Symbol');
  const qtyIdx = header.indexOf('Quantity');
  const priceIdx = header.indexOf('Price Paid $');

  const results = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break; // blank line ends the positions table
    const cells = line.split(',');
    const symbol = (cells[symbolIdx] || '').trim().toUpperCase();
    if (!symbol || symbol === 'CASH' || symbol === 'TOTAL') continue;
    const shares = parseFloat(cells[qtyIdx]);
    if (!shares || shares <= 0) continue;
    const costBasis = priceIdx !== -1 ? parseFloat(cells[priceIdx]) : NaN;
    results.push({ symbol, shares, costBasis: costBasis > 0 ? costBasis : null });
  }
  return results;
}

// Parses an E*TRADE Stock Plan "By Benefit Type (expanded)" export. It's a
// flattened multi-table format: each sheet mixes several record types into
// one grid, so only rows matching a specific Record Type actually carry a
// share count in the columns we want -- other rows are sub-records (vest
// schedules, tax withholding, dividends) that reuse the same header names
// for unrelated per-tranche data further along the row.
//
// ESPP and RSU are kept as separate positions (not merged, even for the same
// symbol): ESPP rows carry a real per-share cost basis, but E*TRADE leaves
// "Est. Cost Basis (per share)" blank on RSU Grant rows for shares that
// haven't been sold yet, so merging them would silently average a known cost
// basis with an unknown one.
async function parseStockPlanWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheetConfigs = [
    { sheetName: 'ESPP', recordType: 'Purchase', label: 'ESPP' },
    { sheetName: 'Restricted Stock', recordType: 'Grant', label: 'RSU' }
  ];

  const positions = [];
  for (const { sheetName, recordType, label } of sheetConfigs) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;

    const header = sheet.getRow(1).values; // 1-indexed, values[0] is undefined
    const recordTypeCol = header.indexOf('Record Type');
    const symbolCol = header.indexOf('Symbol');
    const sellableCol = header.indexOf('Sellable Qty.'); // first occurrence only
    const costBasisCol = header.indexOf('Est. Cost Basis (per share):'); // first occurrence

    if (recordTypeCol === -1 || symbolCol === -1 || sellableCol === -1) continue;

    // symbol -> { shares, costBasisDollars } so a weighted-average cost basis
    // can be computed across multiple lots (e.g. two ESPP purchase periods).
    const totals = new Map();
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = row.values;
      if (values[recordTypeCol] !== recordType) return;
      const symbol = String(values[symbolCol] || '').trim().toUpperCase();
      const shares = Number(values[sellableCol]) || 0;
      if (!symbol || shares <= 0) return;

      const costBasisPerShare = costBasisCol !== -1 ? Number(values[costBasisCol]) : NaN;
      const entry = totals.get(symbol) || { shares: 0, costBasisDollars: 0, costBasisShares: 0 };
      entry.shares += shares;
      if (costBasisPerShare > 0) {
        entry.costBasisDollars += costBasisPerShare * shares;
        entry.costBasisShares += shares;
      }
      totals.set(symbol, entry);
    });

    for (const [symbol, entry] of totals.entries()) {
      positions.push({
        symbol,
        shares: entry.shares,
        type: 'stock', // stock plan holdings are always the underlying company's own shares
        costBasis: entry.costBasisShares > 0 ? entry.costBasisDollars / entry.costBasisShares : null,
        label
      });
    }
  }

  return positions;
}

app.post('/api/portfolio/parse-import', async (req, res) => {
  const files = req.body.files;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Bad request', message: 'Provide a "files" array.' });
  }

  const positions = [];
  const warnings = [];

  for (const file of files) {
    try {
      if (file.type === 'xlsx') {
        const buffer = Buffer.from(file.content, 'base64');
        const parsed = await parseStockPlanWorkbook(buffer);
        if (parsed.length === 0) {
          warnings.push(`No recognizable ESPP/Restricted Stock rows found in ${file.name}.`);
        }
        positions.push(...parsed.map(p => ({ ...p, source: file.name })));
      } else if (file.type === 'csv') {
        const parsed = parseBrokerageCsv(file.content);
        for (const p of parsed) {
          let type = 'stock';
          try {
            type = await fetchQuoteType(p.symbol);
          } catch (err) {
            warnings.push(`Could not classify ${p.symbol} as ETF or stock, defaulted to stock.`);
          }
          positions.push({ symbol: p.symbol, shares: p.shares, type, costBasis: p.costBasis, source: file.name });
        }
      } else {
        warnings.push(`Unrecognized file type for ${file.name}.`);
      }
    } catch (err) {
      warnings.push(`Could not parse ${file.name}: ${err.message}`);
    }
  }

  res.json({ positions, warnings });
});

// ---- Portfolio persistence ----
async function readPortfolio() {
  let positions;
  try {
    const raw = await fs.readFile(PORTFOLIO_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    positions = Array.isArray(parsed.positions) ? parsed.positions : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  // Migrate positions saved before share tracking existed (they stored a
  // dollar amount only) by converting that amount to shares at today's price.
  let migrated = false;
  for (const p of positions) {
    if (typeof p.shares !== 'number' && typeof p.amount === 'number') {
      try {
        const price = await fetchQuotePrice(p.symbol.toUpperCase());
        p.shares = p.amount / price;
        delete p.amount;
        migrated = true;
      } catch (err) {
        console.error(`Could not migrate legacy position ${p.symbol}:`, err.message);
      }
    }
  }
  if (migrated) {
    await writePortfolio(positions);
  }

  return positions;
}

async function writePortfolio(positions) {
  await fs.mkdir(path.dirname(PORTFOLIO_FILE), { recursive: true });
  await fs.writeFile(PORTFOLIO_FILE, JSON.stringify({ positions, savedAt: new Date().toISOString() }, null, 2));
}

app.get('/api/portfolio', async (req, res) => {
  try {
    const positions = await readPortfolio();
    res.json({ positions });
  } catch (err) {
    console.error('Error reading portfolio:', err.message);
    res.status(500).json({ error: 'Server error', message: 'Could not read saved portfolio.' });
  }
});

app.post('/api/portfolio', async (req, res) => {
  const positions = req.body.positions;
  if (!Array.isArray(positions)) {
    return res.status(400).json({ error: 'Bad request', message: 'Body must include a "positions" array.' });
  }
  for (const p of positions) {
    if (!p.symbol || !['etf', 'stock'].includes(p.type) || typeof p.shares !== 'number' || p.shares <= 0) {
      return res.status(400).json({
        error: 'Bad request',
        message: 'Each position needs { type: "etf"|"stock", symbol: string, shares: positive number }.'
      });
    }
  }
  try {
    await writePortfolio(positions);
    res.json({ ok: true, count: positions.length });
  } catch (err) {
    console.error('Error saving portfolio:', err.message);
    res.status(500).json({ error: 'Server error', message: 'Could not save portfolio.' });
  }
});

// ---- Portfolio concentration: look through ETFs to underlying stocks ----
app.get('/api/portfolio/concentration', async (req, res) => {
  let positions;
  try {
    positions = await readPortfolio();
  } catch (err) {
    return res.status(500).json({ error: 'Server error', message: 'Could not read saved portfolio.' });
  }

  if (positions.length === 0) {
    return res.status(400).json({ error: 'Empty portfolio', message: 'Add and save some positions first.' });
  }

  const exposure = new Map(); // symbol -> { name, value, sources: Set }
  const warnings = [];
  const positionValues = [];
  let totalValue = 0;
  let totalCostBasis = 0;
  let costBasisKnownCount = 0;

  for (const pos of positions) {
    const symbol = pos.symbol.toUpperCase();

    let price;
    try {
      price = await fetchQuotePrice(symbol);
    } catch (err) {
      warnings.push(`Skipped ${symbol}: ${err.message}`);
      // Keep this 1:1 with `positions` (even on failure) so the frontend can
      // match live values back to on-screen rows by index, incl. duplicates.
      positionValues.push({ type: pos.type, symbol, shares: pos.shares, price: null, value: null });
      continue;
    }

    const value = pos.shares * price;
    totalValue += value;

    // Gain/loss since acquisition -- only known for positions with a real
    // cost basis (from a broker import), not manually-added ones.
    let gainDollar = null;
    let gainPercent = null;
    if (typeof pos.costBasis === 'number' && pos.costBasis > 0) {
      const costBasisValue = pos.shares * pos.costBasis;
      gainDollar = value - costBasisValue;
      gainPercent = (gainDollar / costBasisValue) * 100;
      totalCostBasis += costBasisValue;
      costBasisKnownCount++;
    }

    positionValues.push({
      type: pos.type,
      symbol,
      shares: pos.shares,
      price,
      value,
      costBasis: pos.costBasis ?? null,
      label: pos.label ?? null,
      gainDollar,
      gainPercent
    });

    if (pos.type === 'stock') {
      const entry = exposure.get(symbol) || { name: symbol, value: 0, sources: new Set() };
      entry.value += value;
      entry.sources.add('direct');
      exposure.set(symbol, entry);
      continue;
    }

    try {
      const etf = await fetchEtfHoldings(symbol);
      for (const h of etf.holdings) {
        const key = h.t.toUpperCase();
        const entry = exposure.get(key) || { name: h.n, value: 0, sources: new Set() };
        entry.value += value * (h.w / 100);
        entry.sources.add(symbol);
        exposure.set(key, entry);
      }
    } catch (err) {
      warnings.push(`Skipped holdings for ${symbol}: ${err.message}`);
    }
  }

  const rows = Array.from(exposure.entries())
    .map(([symbol, d]) => ({
      symbol,
      name: d.name,
      value: d.value,
      weight: totalValue ? (d.value / totalValue) * 100 : 0,
      sources: Array.from(d.sources)
    }))
    .sort((a, b) => b.weight - a.weight);

  const top10Concentration = rows.slice(0, 10).reduce((sum, r) => sum + r.weight, 0);

  const gainDollar = costBasisKnownCount > 0 ? positionValues.reduce((sum, p) => sum + (p.gainDollar || 0), 0) : null;
  const gainPercent = costBasisKnownCount > 0 && totalCostBasis > 0 ? (gainDollar / totalCostBasis) * 100 : null;

  res.json({
    totalValue,
    positionCount: positions.length,
    uniqueStockCount: rows.length,
    top10Concentration,
    rows,
    positions: positionValues,
    gain: {
      dollar: gainDollar,
      percent: gainPercent,
      costBasisValue: costBasisKnownCount > 0 ? totalCostBasis : null,
      knownCount: costBasisKnownCount,
      unknownCount: positions.length - costBasisKnownCount
    },
    warnings
  });
});

app.listen(PORT, () => {
  console.log(`ETF holdings app running at http://localhost:${PORT}`);
});
