/**
 * TMP — connect to the running slushy.trade-mcp with a real Bearer token and
 * exercise the tools end-to-end. Token via MCP_TOKEN env.
 *   MCP_TOKEN=<token> npx tsx scripts/drive.ts
 * Throwaway.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.argv[3] ?? 'http://127.0.0.1:8788/mcp';
const TOKEN = process.env.MCP_TOKEN ?? process.argv[2];
if (!TOKEN) { console.error('MCP_TOKEN=<token> npx tsx scripts/drive.ts'); process.exit(1); }

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = (r.content as any[])?.[0]?.text ?? '';
  return { isError: !!r.isError, txt };
};
const show = (label: string, r: { isError: boolean; txt: string }, max = 220) =>
  console.log(`\n• ${label}${r.isError ? '  [ERROR]' : ''}\n  ${r.txt.replace(/\s+/g, ' ').slice(0, max)}`);

(async () => {
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'drive', version: '0' });
  await client.connect(transport);
  console.log('connected ✓ (auth + on-chain supporter gate passed)');

  show('get_supporter_status', await call(client, 'get_supporter_status'));
  show('get_account', await call(client, 'get_account'), 300);
  const mids = await call(client, 'get_all_mids');
  console.log(`\n• get_all_mids\n  ${mids.txt.length} bytes; BTC=${(JSON.parse(mids.txt).BTC ?? '?')}`);
  show('get_l2_book BTC', await call(client, 'get_l2_book', { coin: 'BTC' }), 200);

  // trading round-trip: rest a low buy, list it, cancel all
  show('place_order (rest BTC buy @ 10000)', await call(client, 'place_order',
    { coin: 'BTC', isBuy: true, size: '0.001', price: '10000', tif: 'Gtc' }));
  show('get_open_orders', await call(client, 'get_open_orders'), 300);
  show('cancel_all_orders', await call(client, 'cancel_all_orders'));

  await client.close();
  console.log('\ndone.');
})().catch((e) => { console.error('drive failed:', e?.message ?? e); process.exit(2); });
