/** TMP — close_position must flatten AND cancel the TP/SL bracket. MCP_TOKEN env. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'close', version: '0' });
  await client.connect(t);
  const call = async (n: string, a: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name: n, arguments: a })).content as any[])[0].text);

  await call('reset_account'); await call('set_balance', { balance: 5000 });
  const mid = Number((await call('get_all_mids')).XRP);
  await call('place_order', { coin: 'XRP', isBuy: true, size: '100', price: (mid * 1.01).toFixed(4), tif: 'Ioc', leverage: 5, takeProfitPx: '1.3496', stopLossPx: '1.3140' });

  const before = await call('get_open_orders');
  check('bracket present before close', before.filter((o: any) => o.isTrigger).length === 2, `${before.length} open (${before.filter((o: any) => o.isTrigger).length} triggers)`);

  const res = await call('close_position', { coin: 'XRP' });
  console.log('  close result:', JSON.stringify(res).slice(0, 160));

  const acct = await call('get_account');
  const after = await call('get_open_orders');
  check('position flattened', (acct.assetPositions?.length ?? 0) === 0, `positions=${acct.assetPositions?.length}`);
  check('TP/SL bracket cancelled (no dangling triggers)', after.filter((o: any) => o.isTrigger).length === 0, `open orders after close=${after.length}, triggers=${after.filter((o: any) => o.isTrigger).length}`);

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
