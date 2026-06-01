/**
 * HTTP smoke of the new sub-DEX MCP tools against a running MCP server.
 * Exercises the real /mcp transport + auth (Bearer token), not an
 * in-process bypass — proves the same path a hosted LLM client would take.
 *
 *   MCP_URL=http://localhost:8788 \
 *   MCP_TOKEN=<base64url token from `npm run token`> \
 *   npm run subdex-smoke
 *
 *   # or pass the private key and let this script mint the token:
 *   MCP_URL=http://localhost:8788 PRIVATE_KEY=0x... npm run subdex-smoke
 *
 * Pass MODE=live to test the live-mode read routing too (defaults to paper).
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
const mode = (process.env.MODE ?? 'paper') as 'paper' | 'live';
const url = mode === 'live' ? `${base}/mcp?mode=live` : `${base}/mcp`;

const token = process.env.MCP_TOKEN
  ?? (process.env.PRIVATE_KEY ? await mintToken(process.env.PRIVATE_KEY) : '');
if (!token) {
  console.error('Set MCP_TOKEN=<base64url> or PRIVATE_KEY=0x… so the script can mint one.');
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: 'subdex-smoke', version: '0.0.0' });
await client.connect(transport);

const list = await client.listTools();
const known = new Set(list.tools.map((t) => t.name));

const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) return { __error: (res.content as Array<{ text?: string }>)?.[0]?.text };
  const text = (res.content as Array<{ text?: string }>)?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
};

const probe = async (label: string, name: string, args: Record<string, unknown> = {}) => {
  if (!known.has(name)) { console.log(`  [missing] ${label}: ${name}`); return; }
  try {
    const r = await call(name, args);
    const head = Array.isArray(r)
      ? `ARRAY len=${r.length}  ${JSON.stringify(r.slice(0, 2)).slice(0, 240)}`
      : (r && typeof r === 'object' ? JSON.stringify(r).slice(0, 360) : String(r));
    console.log(`\n--- ${label}: ${name}(${JSON.stringify(args)}) ---\n  ${head}`);
  } catch (e) { console.log(`  [ERROR] ${name}: ${(e as Error).message}`); }
};

console.log(`mode=${mode}  url=${url}`);
console.log(`tools registered: ${known.size}`);
console.log(`  new tools present: get_perp_dexs=${known.has('get_perp_dexs')}  get_all_dex_accounts=${known.has('get_all_dex_accounts')}`);

console.log('\n=== A. new discovery tools ===');
await probe('A1', 'get_perp_dexs');
await probe('A2', 'get_all_dex_accounts');

console.log('\n=== B. dex-scoped reads (paper account; xyz seeded by ensureAccount) ===');
await probe('B1', 'get_account');                            // native
await probe('B2', 'get_account', { dex: 'xyz' });             // xyz subaccount — accountValue=5000 seeded
await probe('B3', 'get_open_orders', { dex: 'xyz' });          // xyz:MU TP/SL if still resting
await probe('B4', 'get_meta', { dex: 'xyz' });                 // xyz universe
await probe('B5', 'get_order_history', { dex: 'xyz', limit: 3 });
await probe('B6', 'get_fills', { dex: 'xyz' });

console.log('\n=== C. modify_bracket parses dex from coin ("xyz:MU") ===');
await probe('C1', 'modify_bracket', { coin: 'xyz:MU', takeProfitPx: '1100', stopLossPx: '950' });

console.log('\n=== D. cancel_all_orders scoping (dex:"" = native only; no-arg = all dexes — skipped, would mutate) ===');
await probe('D1', 'cancel_all_orders', { dex: '' });

await client.close();
process.exit(0);
