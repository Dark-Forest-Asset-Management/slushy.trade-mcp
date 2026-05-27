/** TMP — verify ONE place_order call submits a linked OCO bracket (entry+TP+SL,
 *  grouping normalTpsl). Resets the paper account first. MCP_TOKEN env. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'bracket-test', version: '0' });
  await client.connect(t);
  const call = async (n: string, a: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name: n, arguments: a })).content as any[])[0].text);

  await call('reset_account');
  await call('set_balance', { balance: 5000 });
  const mid = Number((await call('get_all_mids')).XRP);
  console.log(`XRP mid=${mid} — placing ONE bracket call (entry + TP + SL)`);

  const resp = await call('place_order', {
    coin: 'XRP', isBuy: true, size: '100', price: (mid * 1.01).toFixed(4), tif: 'Ioc',
    takeProfitPx: '1.3496', stopLossPx: '1.3140',
  });
  const statuses = resp?.response?.data?.statuses ?? [];
  console.log(`\nsingle call → ${statuses.length} statuses:`);
  for (const s of statuses) console.log('  ', JSON.stringify(s));

  const acct = await call('get_account');
  const pos = acct.assetPositions[0]?.position;
  console.log('\nposition:', pos ? `${pos.coin} szi=${pos.szi} entry=${pos.entryPx}` : 'none');
  const oo = await call('get_open_orders');
  console.log('open orders (the OCO legs):');
  for (const o of oo) console.log(`  ${o.orderType} ${o.side} ${o.sz} trig=${o.triggerPx} isPositionTpsl=${o.isPositionTpsl} (${o.triggerCondition})`);

  console.log(`\n${statuses.length === 3 && oo.length === 2 && pos ? 'PASS — entry filled + TP + SL placed as one normalTpsl group' : 'CHECK output above'}`);
  await client.close();
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
