/** TMP — (2) get_portfolio + get_funding_history, (3) TWAP slices over time. MCP_TOKEN env. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'final', version: '0' });
  await client.connect(t);
  const call = async (n: string, a: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name: n, arguments: a })).content as any[])[0].text);

  // (2)
  const pf = await call('get_portfolio');
  check('get_portfolio (8 periods)', Array.isArray(pf) && pf.length === 8, `periods=${Array.isArray(pf) ? pf.map((p: any) => p[0]).join(',') : pf}`);
  const fh = await call('get_funding_history');
  check('get_funding_history (array)', Array.isArray(fh), `${Array.isArray(fh) ? fh.length + ' rows' : typeof fh}`);

  // (3) TWAP over time — place, wait for the first ~30s slice to fill
  await call('reset_account'); await call('set_balance', { balance: 5000 });
  const tw = await call('place_twap', { coin: 'XRP', isBuy: true, size: '30', minutes: 5 });
  const twapId = tw?.response?.data?.status?.running?.twapId;
  console.log(`placed TWAP id=${twapId}; waiting 35s for the first slice…`);
  await sleep(35000);
  const fills = await call('get_fills');
  const acct = await call('get_account');
  const pos = acct.assetPositions[0]?.position;
  check('TWAP fired a slice (fill + position)', Array.isArray(fills) && fills.length >= 1 && !!pos, `fills=${Array.isArray(fills) ? fills.length : 0}, pos szi=${pos?.szi ?? 'none'}`);
  const cx = await call('cancel_twap', { coin: 'XRP', twapId });
  check('cancel_twap stops it', cx?.response?.data?.status === 'success', `cancel=${cx?.response?.data?.status}`);

  await call('reset_account');
  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
