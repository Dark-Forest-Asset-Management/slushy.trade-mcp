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

interface MetaCache { byCoin: Map<string, number>; szDecimals: Map<string, number>; at: number; }
let metaCache: MetaCache | null = null;
const META_TTL_MS = 60_000;

async function loadMeta(): Promise<MetaCache> {
  if (metaCache && Date.now() - metaCache.at < META_TTL_MS) return metaCache;
  const meta = await hypaper.info({ type: 'meta' }) as { universe: Array<{ name: string; szDecimals: number }> };
  const byCoin = new Map<string, number>();
  const szDecimals = new Map<string, number>();
  meta.universe.forEach((u, i) => { byCoin.set(u.name.toUpperCase(), i); szDecimals.set(u.name.toUpperCase(), u.szDecimals); });
  metaCache = { byCoin, szDecimals, at: Date.now() };
  return metaCache;
}

export async function resolveAsset(coin: string): Promise<number> {
  const m = await loadMeta();
  const idx = m.byCoin.get(coin.toUpperCase());
  if (idx === undefined) throw new Error(`Unknown coin "${coin}". Use a perp name like BTC, ETH, SOL.`);
  return idx;
}
