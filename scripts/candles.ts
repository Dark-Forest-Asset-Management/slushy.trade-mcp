/** TMP — pull OHLC for a coin via the MCP get_candles tool. MCP_TOKEN env. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const TOKEN = process.env.MCP_TOKEN!;
const coin = process.argv[2] ?? 'XRP';
const interval = process.argv[3] ?? '1h';

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'candles', version: '0' });
  await client.connect(t);
  const startTime = Date.now() - 12 * 3600_000;
  const r = await client.callTool({ name: 'get_candles', arguments: { coin, interval, startTime } });
  const txt = (r.content as any[])?.[0]?.text ?? '';
  if (r.isError) { console.log('ERROR:', txt.slice(0, 200)); process.exit(1); }
  const candles = JSON.parse(txt);
  console.log(`${coin} ${interval}: ${candles.length} candles (last 12h)`);
  const fmt = (c: any) => `  t=${new Date(c.t).toISOString().slice(5, 16)}  O=${c.o} H=${c.h} L=${c.l} C=${c.c}  V=${c.v}`;
  console.log('first:'); console.log(fmt(candles[0]));
  console.log('last:'); console.log(fmt(candles[candles.length - 1]));
  await client.close();
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
