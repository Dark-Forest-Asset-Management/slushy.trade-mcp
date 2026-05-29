/**
 * Thin HTTP client for the HyPaper backend.
 *
 * Trading goes through HyPaper's UNSIGNED exchange path (`{ wallet, action }`)
 * — the MCP server is trusted (gated by the supporter subscription) and acts
 * on behalf of the authenticated wallet, which HyPaper records as the paper
 * account. No HL L1 signing is needed (and the server holds no user keys).
 */

import { config } from './config.js';

async function post(path: string, body: object): Promise<any> {
  const r = await fetch(`${config.hypaperHttpUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`HyPaper ${path} non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok) {
    throw new Error(`HyPaper ${path} HTTP ${r.status}: ${typeof json === 'object' ? JSON.stringify(json) : text}`);
  }
  return json;
}

export const hypaper = {
  /** POST /info — market data (proxied to HL) + paper account state. */
  info: (body: object) => post('/info', body),
  /** POST /exchange — unsigned, attributed to `wallet`. */
  exchange: (wallet: string, action: object, extra: object = {}) =>
    post('/exchange', { wallet, action, ...extra }),
  /** POST /hypaper — paper-only admin (reset/setBalance/getAccountInfo). */
  admin: (body: object) => post('/hypaper', body),
};

// ── coin → asset index resolution (cached) ──────────────────────────────
// HL/HyPaper order wires use a numeric asset index, but humans say "BTC".
// `meta.universe[i].name` → i. Cached for a minute.

interface AssetInfo { assetId: number; szDecimals: number }
const META_TTL_MS = 60_000;
// One universe map per namespace: '' = main perps (assetId = universe index);
// a sub-DEX name (e.g. 'xyz') → HL global ids 100000 + dexIdx*10000 + uIdx,
// matching slushy (App.tsx) + HL /exchange's expected encoding.
const universeCache = new Map<string, { byCoin: Map<string, AssetInfo>; at: number }>();
let dexIndexCache: { map: Map<string, number>; at: number } | null = null;

/** perpDexs → name → array index (1=xyz, 2=flx, …; index 0 is the null main). */
async function getDexIndex(dex: string): Promise<number> {
  if (!dexIndexCache || Date.now() - dexIndexCache.at > META_TTL_MS) {
    const list = await hypaper.info({ type: 'perpDexs' }) as Array<{ name?: string } | null>;
    const map = new Map<string, number>();
    list.forEach((d, i) => { if (d && d.name) map.set(d.name.toLowerCase(), i); });
    dexIndexCache = { map, at: Date.now() };
  }
  const idx = dexIndexCache.map.get(dex.toLowerCase());
  if (idx === undefined) throw new Error(`Unknown perp DEX "${dex}".`);
  return idx;
}

async function loadUniverse(dex: string): Promise<Map<string, AssetInfo>> {
  const cached = universeCache.get(dex);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.byCoin;
  const byCoin = new Map<string, AssetInfo>();
  if (dex === '') {
    const meta = await hypaper.info({ type: 'meta' }) as { universe: Array<{ name: string; szDecimals: number }> };
    meta.universe.forEach((u, i) => byCoin.set(u.name.toUpperCase(), { assetId: i, szDecimals: u.szDecimals }));
  } else {
    const dexIdx = await getDexIndex(dex);
    const [meta] = await hypaper.info({ type: 'metaAndAssetCtxs', dex }) as [{ universe: Array<{ name: string; szDecimals: number }> }, unknown];
    meta.universe.forEach((u, i) => byCoin.set(u.name.toUpperCase(), { assetId: 100_000 + dexIdx * 10_000 + i, szDecimals: u.szDecimals }));
  }
  universeCache.set(dex, { byCoin, at: Date.now() });
  return byCoin;
}

/** Resolve a coin to its asset info. Sub-DEX perps are addressed as
 *  "xyz:SYMBOL" (e.g. xyz:TSLA); main perps as a bare name (BTC). */
async function assetInfo(coin: string): Promise<AssetInfo> {
  const dex = coin.includes(':') ? coin.split(':')[0] : '';
  const info = (await loadUniverse(dex)).get(coin.toUpperCase());
  if (!info) throw new Error(`Unknown coin "${coin}". Main perps use a bare name (BTC, ETH); sub-DEX perps use "<dex>:SYMBOL" (e.g. xyz:TSLA).`);
  return info;
}

export async function resolveAsset(coin: string): Promise<number> {
  return (await assetInfo(coin)).assetId;
}

/** The asset's szDecimals — drives price tick + size lot rounding. */
export async function getSzDecimals(coin: string): Promise<number> {
  return (await assetInfo(coin)).szDecimals;
}
