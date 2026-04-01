/**
 * /api/prices.js — CoinGecko proxy for RRG Dashboard
 *
 * Endpoints this function handles:
 *
 *   GET /api/prices?id=bitcoin&days=180
 *     → returns array of [timestamp, price] pairs (daily closes)
 *     → used to build sector index price series
 *
 *   GET /api/prices?id=bitcoin&days=180&includeMarketCap=true
 *     → returns { prices: [...], market_caps: [...] }
 *     → used for mcap-weighted index construction
 *
 *   GET /api/prices?batch=bitcoin,ethereum,solana&days=180
 *     → returns { bitcoin: [...], ethereum: [...], solana: [...] }
 *     → fetches multiple coins in one request (up to 25 per call)
 *
 *   GET /api/prices?id=bitcoin&days=180&includeVolume=true
 *     → returns { prices: [...], total_volumes: [...] }
 *     → used for liquidity-weighted index construction
 *
 * Environment variables required:
 *   CG_API_KEY  — your CoinGecko API key (set in Vercel dashboard)
 */

const CG_BASE = 'https://pro-api.coingecko.com/api/v3';

// In-memory cache: key → { data, expiresAt }
// Vercel serverless functions are stateless between cold starts,
// but this prevents redundant calls within the same function instance.
const CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — daily closes don't change intraday

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { CACHE.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchCG(path, apiKey) {
  const url = `${CG_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'x-cg-pro-api-key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CoinGecko ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

async function getSingle(id, days, flags, apiKey) {
  const cacheKey = `${id}:${days}:${JSON.stringify(flags)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const path = `/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const raw = await fetchCG(path, apiKey);

  let result;
  if (flags.includeMarketCap && flags.includeVolume) {
    result = {
      prices: raw.prices,
      market_caps: raw.market_caps,
      total_volumes: raw.total_volumes,
    };
  } else if (flags.includeMarketCap) {
    result = { prices: raw.prices, market_caps: raw.market_caps };
  } else if (flags.includeVolume) {
    result = { prices: raw.prices, total_volumes: raw.total_volumes };
  } else {
    result = raw.prices; // just [[timestamp, price], ...]
  }

  cacheSet(cacheKey, result);
  return result;
}

async function getBatch(ids, days, apiKey) {
  // Fetch all in parallel — CoinGecko allows concurrent requests
  const results = await Promise.allSettled(
    ids.map(id => getSingle(id, days, {}, apiKey).then(data => ({ id, data })))
  );

  const out = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      out[r.value.id] = r.value.data;
    } else {
      // Return null for failed tickers — dashboard handles gracefully
      const id = ids[results.indexOf(r)];
      out[id] = null;
      console.error(`Failed to fetch ${id}:`, r.reason?.message);
    }
  }
  return out;
}

export default async function handler(req, res) {
  // CORS — allow requests from your Vercel domain and localhost dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.CG_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'CG_API_KEY environment variable not set',
      hint: 'Add it in Vercel dashboard → Settings → Environment Variables',
    });
  }

  const { id, batch, days = '180', includeMarketCap, includeVolume } = req.query;

  // Validate days param
  const daysNum = parseInt(days);
  if (isNaN(daysNum) || daysNum < 1 || daysNum > 365) {
    return res.status(400).json({ error: 'days must be between 1 and 365' });
  }

  try {
    // ── BATCH MODE ──────────────────────────────────────────────
    if (batch) {
      const ids = batch
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 50); // safety cap

      if (ids.length === 0) {
        return res.status(400).json({ error: 'batch param is empty' });
      }

      const data = await getBatch(ids, daysNum, apiKey);

      // Cache for 6 hours on CDN edge
      res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
      return res.status(200).json(data);
    }

    // ── SINGLE MODE ─────────────────────────────────────────────
    if (!id) {
      return res.status(400).json({
        error: 'Missing required param: id or batch',
        example: '/api/prices?id=bitcoin&days=180',
      });
    }

    const flags = {
      includeMarketCap: includeMarketCap === 'true',
      includeVolume: includeVolume === 'true',
    };

    const data = await getSingle(id, daysNum, flags, apiKey);

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=3600');
    return res.status(200).json(data);

  } catch (err) {
    console.error('Price proxy error:', err.message);

    // Pass through CoinGecko rate limit errors clearly
    if (err.message.includes('429')) {
      return res.status(429).json({
        error: 'CoinGecko rate limit reached',
        hint: 'The proxy is fetching too frequently. Increase the cache TTL or reduce refresh frequency.',
      });
    }

    return res.status(500).json({
      error: 'Failed to fetch price data',
      detail: err.message,
    });
  }
}
