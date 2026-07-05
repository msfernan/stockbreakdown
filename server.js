require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const FMP_API_KEY = process.env.FMP_API_KEY;

// Simple in-memory cache so repeated lookups don't burn API calls.
// Key: ticker, Value: { data, expiresAt }
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, holdings don't change intraday

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/holdings', async (req, res) => {
  const ticker = (req.query.ticker || '').trim().toUpperCase();

  if (!ticker) {
    return res.status(400).json({ error: 'Missing ticker', message: 'Provide a ticker, e.g. /api/holdings?ticker=SPY' });
  }

  if (!FMP_API_KEY) {
    return res.status(500).json({
      error: 'Server not configured',
      message: 'FMP_API_KEY is missing. Copy .env.example to .env and add your Financial Modeling Prep API key.'
    });
  }

  const cached = cache.get(ticker);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.data);
  }

  try {
    const holdingsUrl = `https://financialmodelingprep.com/stable/etf/holdings?symbol=${ticker}&apikey=${FMP_API_KEY}`;
    const infoUrl = `https://financialmodelingprep.com/stable/etf/info?symbol=${ticker}&apikey=${FMP_API_KEY}`;

    const [holdingsResp, infoResp] = await Promise.all([
      fetch(holdingsUrl),
      fetch(infoUrl)
    ]);

    if (holdingsResp.status === 401 || holdingsResp.status === 403) {
      return res.status(502).json({
        error: 'Upstream access denied',
        message: 'FMP rejected the request. This endpoint may require a paid FMP plan, or your API key may be invalid.'
      });
    }

    if (!holdingsResp.ok) {
      return res.status(502).json({
        error: 'Upstream error',
        message: `FMP returned status ${holdingsResp.status} for ticker ${ticker}.`
      });
    }

    const holdingsRaw = await holdingsResp.json();

    if (!Array.isArray(holdingsRaw) || holdingsRaw.length === 0) {
      return res.status(404).json({
        error: 'No holdings found',
        message: `No holdings data for "${ticker}". Check the ticker is a real ETF, or that your FMP plan covers this data.`
      });
    }

    let fundName = ticker;
    let category = '';
    if (infoResp.ok) {
      const infoRaw = await infoResp.json();
      const info = Array.isArray(infoRaw) ? infoRaw[0] : infoRaw;
      if (info) {
        fundName = info.name || fundName;
        category = info.assetClass || info.sectorsList || '';
      }
    }

    const holdings = holdingsRaw
      .map(h => ({
        t: h.asset || h.symbol || '',
        n: h.name || h.asset || '',
        w: typeof h.weightPercentage === 'number' ? h.weightPercentage : parseFloat(h.weightPercentage) || 0
      }))
      .filter(h => h.t)
      .sort((a, b) => b.w - a.w)
      .slice(0, 15);

    const payload = {
      symbol: ticker,
      name: fundName,
      category,
      holdings
    };

    cache.set(ticker, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json(payload);
  } catch (err) {
    console.error('Error fetching holdings:', err);
    res.status(500).json({ error: 'Server error', message: 'Something went wrong fetching holdings data.' });
  }
});

app.listen(PORT, () => {
  console.log(`ETF holdings app running at http://localhost:${PORT}`);
  if (!FMP_API_KEY) {
    console.warn('Warning: FMP_API_KEY not set. Copy .env.example to .env and add your key.');
  }
});
