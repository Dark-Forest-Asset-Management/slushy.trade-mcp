/** TMP — verify (c) leverage param + (b) tools + in-place modify_bracket. MCP_TOKEN env. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'bc', version: '0' });
  await client.connect(t);
  const call = async (n: string, a: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name: n, arguments: a })).content as any[])[0].text);

  await call('reset_account'); await call('set_balance', { balance: 5000 });
  const mid = Number((await call('get_all_mids')).XRP);

  // (c) place_order bracket WITH explicit leverage=5
  await call('place_order', { coin: 'XRP', isBuy: true, size: '100', price: (mid * 1.01).toFixed(4), tif: 'Ioc', leverage: 5, takeProfitPx: '1.3496', stopLossPx: '1.3140' });
  const acct1 = await call('get_account');
  const lev = acct1.assetPositions[0]?.position?.leverage?.value;
  check('(c) leverage param applied', lev === 5, `position leverage=${lev} (expected 5)`);

  // in-place modify_bracket → new TP/SL prices
  await call('modify_bracket', { coin: 'XRP', takeProfitPx: '1.3550', stopLossPx: '1.3100' });
  const oo = await call('get_open_orders');
  const tp = oo.find((o: any) => /take profit/i.test(o.orderType));
  const sl = oo.find((o: any) => /stop/i.test(o.orderType));
  check('modify_bracket moved TP/SL in place', Math.abs(Number(tp?.triggerPx) - 1.355) < 1e-6 && Math.abs(Number(sl?.triggerPx) - 1.31) < 1e-6, `TP=${tp?.triggerPx} SL=${sl?.triggerPx}`);

  // (b) get_order_status on an open trigger
  const st = await call('get_order_status', { oid: tp.oid });
  check('(b) get_order_status', st.status === 'order' || st.status === 'unknownOid', `status=${st.status}`);

  // (b) get_asset_contexts
  const ctx = await call('get_asset_contexts');
  check('(b) get_asset_contexts', Array.isArray(ctx) && ctx.length === 2 && Array.isArray(ctx[1]) && ctx[1][0]?.markPx, `ctxs=${ctx?.[1]?.length} sample markPx=${ctx?.[1]?.[0]?.markPx}`);

  // (b) close_position
  await call('close_position', { coin: 'XRP' });
  const acct2 = await call('get_account');
  check('(b) close_position flattened', (acct2.assetPositions?.length ?? 0) === 0, `positions=${acct2.assetPositions?.length}`);

  // (b) place_twap + cancel_twap
  const tw = await call('place_twap', { coin: 'XRP', isBuy: true, size: '50', minutes: 5 });
  const twapId = tw?.response?.data?.status?.running?.twapId;
  const cx = await call('cancel_twap', { coin: 'XRP', twapId });
  check('(b) place_twap + cancel_twap', twapId !== undefined && cx?.response?.data?.status === 'success', `twapId=${twapId} cancel=${cx?.response?.data?.status}`);

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
