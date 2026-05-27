/**
 * TMP — open a fib-bounce LONG bracket on XRP via the MCP tools, then confirm.
 * Thesis: price retraced the whole 1.3054→1.3750 move to the 0.618 (1.3321)
 * zone; long the bounce, TP at a fib level above, SL below the 0.786 (1.3203).
 * MCP_TOKEN env. Paper account.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const FIB_UP = [1.3404, 1.3496, 1.3586, 1.3750]; // 0.5, 0.382, 0.236, 0
const SL = 1.3140;     // below 0.786 (1.3203) — break invalidates the bounce
const SIZE = '100';    // 100 XRP, paper

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'bracket', version: '0' });
  await client.connect(t);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, txt: (r.content as any[])?.[0]?.text ?? '' };
  };

  const mid = Number(JSON.parse((await call('get_all_mids')).txt).XRP);
  const acct = JSON.parse((await call('get_account')).txt);
  console.log(`XRP mid=${mid}  accountValue=$${acct.marginSummary.accountValue}  openPositions=${acct.assetPositions.length}`);

  const TP = FIB_UP.find((p) => p > mid * 1.012);
  const rr = TP ? (TP - mid) / (mid - SL) : 0;
  console.log(`plan: LONG ${SIZE} XRP | entry≈${mid} | TP=${TP} | SL=${SL} | R:R=${rr.toFixed(2)}`);
  if (!(mid > 1.314 && mid < 1.36 && TP && rr >= 1.2)) {
    console.log(`ABORT — price out of the 0.618-bounce thesis range or R:R<1.2.`);
    process.exit(1);
  }

  console.log('\n— ENTRY (market long, IOC) —');
  console.log((await call('place_order', { coin: 'XRP', isBuy: true, size: SIZE, price: (mid * 1.01).toFixed(4), tif: 'Ioc' })).txt);
  console.log('\n— TAKE PROFIT (trigger, reduceOnly) —');
  console.log((await call('place_order', { coin: 'XRP', isBuy: false, size: SIZE, price: TP!.toFixed(4), reduceOnly: true, trigger: { triggerPx: TP!.toFixed(4), isMarket: true, tpsl: 'tp' } })).txt);
  console.log('\n— STOP LOSS (trigger, reduceOnly) —');
  console.log((await call('place_order', { coin: 'XRP', isBuy: false, size: SIZE, price: SL.toFixed(4), reduceOnly: true, trigger: { triggerPx: SL.toFixed(4), isMarket: true, tpsl: 'sl' } })).txt);

  console.log('\n— ACCOUNT AFTER —');
  const after = JSON.parse((await call('get_account')).txt);
  const pos = after.assetPositions[0]?.position;
  console.log(pos ? `position: ${pos.coin} szi=${pos.szi} entry=${pos.entryPx} uPnL=${pos.unrealizedPnl} liq=${pos.liquidationPx}` : 'no position');
  console.log('\n— OPEN ORDERS —');
  const oo = JSON.parse((await call('get_open_orders')).txt);
  for (const o of oo) console.log(`  ${o.orderType} ${o.side} ${o.sz} @ trig ${o.triggerPx} (${o.triggerCondition})`);

  await client.close();
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
