/**
 * HTTP smoke of the new bracket-tracker MCP tools against a running MCP
 * server. Exercises the real /mcp transport + auth — same path a hosted
 * LLM client takes. Mirrors mcp-subdex-smoke.ts.
 *
 *   MCP_URL=http://localhost:8788 \
 *   MCP_TOKEN=<base64url token from `npm run token`> \
 *   npx tsx scripts/mcp-bracket-smoke.ts
 *
 *   # or pass the private key and let this script mint the token:
 *   MCP_URL=http://localhost:8788 PRIVATE_KEY=0x... npx tsx scripts/mcp-bracket-smoke.ts
 */

import { ethers } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function mcpAccessMessage(address: string): string {
  return `slushy.trade MCP access\nwallet: ${address.toLowerCase()}`;
}

async function mintToken(pk: string): Promise<string> {
  const wallet = new ethers.Wallet(pk);
  const signature = await wallet.signMessage(mcpAccessMessage(wallet.address));
  return Buffer.from(JSON.stringify({ address: wallet.address, signature }), 'utf8').toString('base64url');
}

const base = (process.env.MCP_URL ?? 'http://localhost:8788').replace(/\/$/, '');
const url = `${base}/mcp`;

const token = process.env.MCP_TOKEN
  ?? (process.env.PRIVATE_KEY ? await mintToken(process.env.PRIVATE_KEY) : '');
if (!token) {
  console.error('Set MCP_TOKEN=<base64url> or PRIVATE_KEY=0x… so the script can mint one.');
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'bracket-smoke', version: '0.0.0' });
await client.connect(transport);

const list = await client.listTools();
const known = new Set(list.tools.map((t) => t.name));

const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) return { __error: (res.content as Array<{ text?: string }>)?.[0]?.text };
  const text = (res.content as Array<{ text?: string }>)?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
};

const probe = async (label: string, name: string, args: Record<string, unknown> = {}, summarize?: (r: unknown) => string) => {
  if (!known.has(name)) { console.log(`  [missing] ${label}: ${name}`); return; }
  try {
    const r = await call(name, args);
    const head = summarize
      ? summarize(r)
      : (r && typeof r === 'object' ? JSON.stringify(r).slice(0, 360) : String(r));
    console.log(`\n--- ${label}: ${name}(${JSON.stringify(args)}) ---\n  ${head}`);
  } catch (e) { console.log(`  [ERROR] ${name}: ${(e as Error).message}`); }
};

console.log(`url=${url}`);
console.log(`tools registered: ${known.size}`);
console.log(`  bracket tools present: get_resting_brackets=${known.has('get_resting_brackets')}  get_bracket_clusters=${known.has('get_bracket_clusters')}`);

console.log('\n=== A. raw leg payload (get_resting_brackets) ===');
await probe('A1', 'get_resting_brackets', { coin: 'XRP' }, (r) => {
  const d = r as { asset_name?: string; mid_usd?: number; snapshot_block?: number; snapshot_age_ms?: number; legs?: unknown[] };
  if (!d.legs) return JSON.stringify(d).slice(0, 240);
  const legs = d.legs as Array<{ kind?: string; bracket?: string | null; entry_px?: number | null }>;
  const oco = legs.filter((L) => L.bracket === 'oco').length;
  const withEntry = legs.filter((L) => L.entry_px != null).length;
  return `${d.asset_name} block=${d.snapshot_block} age_ms=${d.snapshot_age_ms} mid=$${d.mid_usd} legs=${legs.length} oco=${oco / 2} pairs with_entry=${withEntry}`;
});

console.log('\n=== B. bucketed density (get_bracket_clusters) ===');
await probe('B1', 'get_bracket_clusters', { coin: 'XRP' }, (r) => {
  const d = r as { mid_usd?: number; band_low_usd?: number; band_high_usd?: number; bucket_width_usd?: number; buckets?: Array<Record<string, number>>; total_legs?: number; in_range_legs?: number };
  if (!d.buckets) return JSON.stringify(d).slice(0, 240);
  return `mid=$${d.mid_usd} band=$${d.band_low_usd?.toFixed(4)}–$${d.band_high_usd?.toFixed(4)} step=$${d.bucket_width_usd?.toFixed(6)} buckets=${d.buckets.length} in_range=${d.in_range_legs}/${d.total_legs}`;
});

await probe('B2', 'get_bracket_clusters', { coin: 'XRP', onlyOco: true, bins: 20, bandPct: 50 }, (r) => {
  const d = r as { mid_usd?: number; buckets?: Array<Record<string, number>>; filtered_legs?: number; total_legs?: number; in_range_legs?: number };
  if (!d.buckets) return JSON.stringify(d).slice(0, 240);
  // Show the top-3 buckets by total trigger count
  const ranked = d.buckets.map((b, i) => ({ i, b, count: (b.tp_long_count ?? 0) + (b.tp_short_count ?? 0) + (b.sl_long_count ?? 0) + (b.sl_short_count ?? 0) }))
    .sort((a, b) => b.count - a.count).slice(0, 3);
  const tops = ranked.map((r) => `[${r.i}] $${r.b.price_low?.toFixed(4)}–$${r.b.price_high?.toFixed(4)} n=${r.count}`).join('  ');
  return `mid=$${d.mid_usd} ocoOnly_filtered=${d.filtered_legs}/${d.total_legs} in_range=${d.in_range_legs}  top buckets: ${tops}`;
});

console.log('\n=== C. unknown coin → error path ===');
await probe('C1', 'get_resting_brackets', { coin: 'NOPECOIN' }, (r) => {
  const d = r as { __error?: string };
  return d.__error ? `error surfaced: ${d.__error.slice(0, 180)}` : `unexpected: ${JSON.stringify(d).slice(0, 180)}`;
});

await client.close();
console.log('\nsmoke complete.');
process.exit(0);
