/**
 * TMP — verify streaming: resource subscribe + live resources/updated pushes.
 * Subscribes to mids, l2/XRP, fills, orders, account; triggers a fill; counts
 * the resource-updated notifications per uri. MCP_TOKEN env.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = 'http://127.0.0.1:8788';
const URIS = ['slushy://mids', 'slushy://l2/XRP', 'slushy://fills', 'slushy://orders', 'slushy://account'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'streaming', version: '0' });

  const updates = new Map<string, number>();
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    const uri = (n.params as { uri: string }).uri;
    updates.set(uri, (updates.get(uri) ?? 0) + 1);
  });

  await client.connect(t);
  const call = async (n: string, a: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name: n, arguments: a })).content as any[])[0].text);

  await call('reset_account'); await call('set_balance', { balance: 5000 });

  // subscribe ONLY (no read) — subscribe must start the upstream feed itself
  for (const uri of URIS) {
    try { await client.subscribeResource({ uri }); } catch (e) { console.log(`  subscribe ${uri} FAILED: ${(e as Error).message}`); }
  }
  console.log('subscribed (no read bootstrap); waiting for market ticks…');
  await sleep(3000);

  // trigger user-feed updates: a filling buy + a resting order
  const mid = Number((await call('get_all_mids')).XRP);
  await call('place_order', { coin: 'XRP', isBuy: true, size: '50', price: (mid * 1.01).toFixed(4), tif: 'Ioc', leverage: 3 });
  await call('place_order', { coin: 'XRP', isBuy: true, size: '5', price: (mid * 0.5).toFixed(4), tif: 'Gtc' });
  await sleep(4000);

  console.log('\nresource-updated counts:');
  for (const uri of URIS) console.log(`  ${updates.get(uri) ? 'PASS' : 'FAIL'}  ${uri}: ${updates.get(uri) ?? 0}`);

  await call('reset_account');
  await client.close();
  process.exit(0);
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
