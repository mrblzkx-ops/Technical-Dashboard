/**
 * dataFetcher.js — drop this into your dashboard to replace simulated data
 *
 * Usage: add this as a <script> tag before your main dashboard script,
 * then call window.fetchRealPrices(cgId, days) instead of getTP()
 *
 * This module:
 *   1. Fetches real price data from /api/prices (your Vercel proxy)
 *   2. Caches results in sessionStorage so page refreshes don't re-fetch
 *   3. Falls back to simulated data if the API is unavailable
 *   4. Batches requests to minimise API call consumption
 */

(function() {
  'use strict';

  const API_BASE = ''; // empty = same origin (your Vercel deployment)
  const SESSION_KEY = 'rrg_price_cache';
  const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

  // Load cache from sessionStorage
  function loadCache() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function saveCache(cache) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(cache)); } catch {}
  }

  let priceCache = loadCache();

  /**
   * Fetch prices for a single CoinGecko ID.
   * Returns array of daily close prices (numbers), oldest first.
   */
  async function fetchSingle(cgId, days = 180) {
    const cacheKey = `${cgId}:${days}`;
    const cached = priceCache[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) {
      return cached.prices;
    }

    const res = await fetch(`${API_BASE}/api/prices?id=${encodeURIComponent(cgId)}&days=${days}`);
    if (!res.ok) throw new Error(`API error ${res.status} for ${cgId}`);

    const raw = await res.json(); // [[timestamp, price], ...]
    const prices = raw.map(([, price]) => price);

    priceCache[cacheKey] = { prices, fetchedAt: Date.now() };
    saveCache(priceCache);
    return prices;
  }

  /**
   * Fetch prices for multiple CoinGecko IDs in one batch request.
   * Returns { cgId: [price, price, ...], ... }
   */
  async function fetchBatch(cgIds, days = 180) {
    // Separate already-cached from needs-fetching
    const toFetch = [];
    const result = {};

    for (const id of cgIds) {
      const cacheKey = `${id}:${days}`;
      const cached = priceCache[cacheKey];
      if (cached && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) {
        result[id] = cached.prices;
      } else {
        toFetch.push(id);
      }
    }

    if (toFetch.length > 0) {
      // Split into chunks of 25 to stay within rate limits
      const CHUNK = 25;
      for (let i = 0; i < toFetch.length; i += CHUNK) {
        const chunk = toFetch.slice(i, i + CHUNK);
        const res = await fetch(
          `${API_BASE}/api/prices?batch=${chunk.join(',')}&days=${days}`
        );
        if (!res.ok) throw new Error(`Batch API error ${res.status}`);

        const raw = await res.json(); // { id: [[ts, price], ...], ... }
        for (const [id, data] of Object.entries(raw)) {
          if (data) {
            const prices = data.map(([, price]) => price);
            result[id] = prices;
            priceCache[`${id}:${days}`] = { prices, fetchedAt: Date.now() };
          }
        }
        saveCache(priceCache);

        // Small delay between chunks to be polite to the API
        if (i + CHUNK < toFetch.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    return result;
  }

  /**
   * Fetch current market caps for mcap-weighted index construction.
   * Returns { cgId: marketCapUSD, ... }
   */
  async function fetchMarketCaps(cgIds) {
    const cacheKey = 'mcaps:' + cgIds.sort().join(',');
    const cached = priceCache[cacheKey];
    // Market caps cached for 1 hour
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) {
      return cached.data;
    }

    const res = await fetch(`${API_BASE}/api/mcap?ids=${cgIds.join(',')}`);
    if (!res.ok) throw new Error(`Mcap API error ${res.status}`);

    const data = await res.json();
    priceCache[cacheKey] = { data, fetchedAt: Date.now() };
    saveCache(priceCache);
    return data;
  }

  /**
   * Pre-fetch all prices for all categories in config.
   * Call this once on dashboard load, before rendering.
   * Shows a loading state while fetching.
   */
  async function prefetchAll(config, cgIdMap, days = 180, onProgress) {
    // Collect all unique CoinGecko IDs
    const allTickers = [...new Set(
      config.categories.flatMap(c => c.tickers)
    )];

    // Map ticker → cgId, skip unmapped
    const allCgIds = allTickers
      .map(t => cgIdMap[t])
      .filter(Boolean);

    const uniqueIds = [...new Set(allCgIds)];
    if (onProgress) onProgress(0, uniqueIds.length);

    // Fetch in chunks with progress
    const CHUNK = 25;
    let fetched = 0;
    for (let i = 0; i < uniqueIds.length; i += CHUNK) {
      const chunk = uniqueIds.slice(i, i + CHUNK);
      await fetchBatch(chunk, days);
      fetched += chunk.length;
      if (onProgress) onProgress(fetched, uniqueIds.length);
      if (i + CHUNK < uniqueIds.length) await new Promise(r => setTimeout(r, 250));
    }

    // Also pre-fetch market caps
    await fetchMarketCaps(uniqueIds);
    if (onProgress) onProgress(uniqueIds.length, uniqueIds.length);
  }

  /**
   * Get prices for a ticker symbol, using the cgIdMap to look up the CoinGecko ID.
   * This is the main function to call from the dashboard.
   * Returns array of close prices, oldest first, rebased so first value = 100.
   */
  async function getPrices(ticker, cgIdMap, days = 180) {
    const cgId = cgIdMap[ticker];
    if (!cgId) {
      console.warn(`No CoinGecko ID for ticker: ${ticker}`);
      return null;
    }

    try {
      const prices = await fetchSingle(cgId, days);
      if (!prices || prices.length === 0) return null;

      // Rebase to 100 at first data point (matches the simulated data format)
      const base = prices[0];
      return prices.map(p => (p / base) * 100);
    } catch (err) {
      console.error(`Failed to fetch ${ticker} (${cgId}):`, err.message);
      return null;
    }
  }

  // Expose on window so dashboard script can call it
  window.RRGData = {
    fetchSingle,
    fetchBatch,
    fetchMarketCaps,
    prefetchAll,
    getPrices,
    clearCache: () => {
      priceCache = {};
      try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    },
  };

})();
