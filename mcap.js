/**
 * /api/mcap.js — current market cap snapshot for index weighting
 *
 * GET /api/mcap?ids=bitcoin,ethereum,solana
 *   → returns { bitcoin: 1400000000000, ethereum: 240000000000, ... }
 *   → values in USD, used to compute mcap weights at index construction time
 *
 * Called once on dashboard load and cached for 1 hour.
 * Market caps don't need to be real-time for RRG purposes —
 * the weights only need to be approximately correct.
 */

const CG_BASE = 'https://pro-api.coingecko.com/api/v3';
const CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { CACHE.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  CACHE.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.CG_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'CG_API_KEY not set' });

  const { ids } = req.query;
  if (!ids) return res.status(400).json({ error: 'Missing ids param', example: '/api/mcap?ids=bitcoin,ethereum,solana' });

  const idList = ids.split(',').map(s => s.trim()).filter(Boolean).slice(0, 250);
  const cacheKey = idList.sort().join(',');
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(cached);
  }

  try {
    // CoinGecko /coins/markets — returns current mcap for up to 250 coins per page
    const url = `${CG_BASE}/coins/markets?vs_currency=usd&ids=${idList.join(',')}&per_page=250&page=1&sparkline=false`;
    const response = await fetch(url, {
      headers: { 'x-cg-pro-api-key': apiKey, 'Accept': 'application/json' },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CoinGecko ${response.status}: ${text.slice(0, 200)}`);
    }

    const coins = await response.json();

    // Return flat map: { id: market_cap_usd }
    const result = {};
    for (const coin of coins) {
      if (coin.market_cap) {
        result[coin.id] = coin.market_cap;
      }
    }

    cacheSet(cacheKey, result);
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=600');
    return res.status(200).json(result);

  } catch (err) {
    console.error('Mcap proxy error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch market cap data', detail: err.message });
  }
}
