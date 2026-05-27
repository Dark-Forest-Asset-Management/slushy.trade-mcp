/**
 * TMP — verify the newly added tools end-to-end. MCP_TOKEN env.
 *   modify_bracket (+ Redis OCO-link inspection), modify_order,
 *   get_order_history, add_chart_drawing / clear_chart_drawings (+ endpoint).
 */
import { execSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const TOKEN = process.env.MCP_TOKEN!;
const smembers = (k: string) => execSync(`docker exec hypaper-redis-1 redis-cli SMEMBERS ${k}`).toString().trim().split('\n').filter(Boolean);
const getkey = (k: string) => execSync(`docker exec hypaper-redis-1 redis-cli GET ${k}`).toString().trim();

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'newtools', version: '0' });
  await client.connect(t);
  const call = async (n: string, a: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name: n, arguments: a })).content as any[])[0].text);

  await call('reset_account'); await call('set_balance', { balance: 5000 });
  const mid = Number((await call('get_all_mids')).XRP);

  // open a bare LONG position, then modify_bracket to attach TP/SL (positionTpsl)
  await call('place_order', { coin: 'XRP', isBuy: true, size: '100', price: (mid * 1.01).toFixed(4), tif: 'Ioc' });
  const mb = await call('modify_bracket', { coin: 'XRP', takeProfitPx: '1.3496', stopLossPx: '1.3140' });
  const placed = mb.placed?.response?.data?.statuses ?? [];
  const tpOid = placed[0]?.resting?.oid, slOid = placed[1]?.resting?.oid;
  check('modify_bracket placed TP+SL', placed.length === 2 && tpOid && slOid, `oids TP=${tpOid} SL=${slOid}`);

  // OCO inspection: do the two legs mutually reference each other?
  const tpBracket = smembers(`order:${tpOid}:bracket`), slBracket = smembers(`order:${slOid}:bracket`);
  const tpChildren = smembers(`order:${tpOid}:children`), slParent = getkey(`order:${slOid}:parent`);
  const mutual = tpBracket.includes(String(slOid)) && slBracket.includes(String(tpOid));
  console.log(`\n  OCO links: TP.bracket=${JSON.stringify(tpBracket)} SL.bracket=${JSON.stringify(slBracket)} TP.children=${JSON.stringify(tpChildren)} SL.parent=${slParent}`);
  check('modify_bracket legs MUTUALLY OCO-linked', mutual, mutual ? 'each leg cancels the other on fill' : 'NOT mutual — HyPaper positionTpsl is entry-centric (parent/child), so a fill will NOT auto-cancel the sibling');

  // modify_order: rest a limit, then move it
  const rest = await call('place_order', { coin: 'XRP', isBuy: true, size: '5', price: (mid * 0.5).toFixed(4), tif: 'Gtc' });
  const restOid = rest.response.data.statuses[0].resting.oid;
  await call('modify_order', { coin: 'XRP', oid: restOid, isBuy: true, size: '5', price: (mid * 0.6).toFixed(4), tif: 'Gtc' });
  const oo = await call('get_open_orders');
  const moved = oo.find((o: any) => o.sz === '5' && Math.abs(Number(o.limitPx) - mid * 0.6) < 0.01);
  check('modify_order moved the resting limit', !!moved, moved ? `now @ ${moved.limitPx}` : `not found in ${JSON.stringify(oo.map((o: any) => [o.sz, o.limitPx]))}`);

  // get_order_history
  const hist = await call('get_order_history', { limit: 50 });
  check('get_order_history returns rows', Array.isArray(hist) && hist.length >= 1, `${Array.isArray(hist) ? hist.length : 0} rows; first status=${hist[0]?.status}`);

  // add_chart_drawing + endpoint + clear
  await call('add_chart_drawing', { type: 'trend-line', anchors: [{ time: 1779523200, price: 1.31 }, { time: 1779804000, price: 1.366 }], color: '#22d3ee', label: 'uptrend' });
  const ad = await (await fetch(`${BASE}/agent-drawings`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
  check('add_chart_drawing → /agent-drawings', ad.drawings?.length === 1 && ad.drawings[0].type === 'trend-line', `${ad.drawings?.length} drawing(s)`);
  const cl = await call('clear_chart_drawings');
  const ad2 = await (await fetch(`${BASE}/agent-drawings`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as any;
  check('clear_chart_drawings empties buffer', cl.cleared === 1 && ad2.drawings.length === 0, `cleared=${cl.cleared}, now=${ad2.drawings.length}`);

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
