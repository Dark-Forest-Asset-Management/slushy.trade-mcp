/**
 * TMP — verify /drawings push + get_chart_drawings round-trip, and show the
 * combined access status (supporter + verified-executive). MCP_TOKEN env.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) { console.error('MCP_TOKEN=<token> npx tsx scripts/test-drawings.ts'); process.exit(1); }

const SAMPLE = { drawings: [{ type: 'trendline', points: [[1779800000000, 1.34], [1779840000000, 1.33]], color: '#22d3ee' }, { type: 'horizontal', price: 1.35, label: 'resistance' }] };

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

(async () => {
  const up = await fetch(`${BASE}/drawings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(SAMPLE) });
  const upj = await up.json() as any;
  check('POST /drawings (supporter-gated)', up.ok && upj.ok === true, JSON.stringify(upj));

  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'drawings-test', version: '0' });
  await client.connect(t);

  const r = await client.callTool({ name: 'get_chart_drawings', arguments: {} });
  const txt = (r.content as any[])?.[0]?.text ?? '';
  const back = JSON.parse(txt);
  check('get_chart_drawings round-trip', JSON.stringify(back) === JSON.stringify(SAMPLE), `${(back.drawings ?? []).length} drawings back`);

  const s = await client.callTool({ name: 'get_supporter_status', arguments: {} });
  console.log(`\n• access status:\n  ${(s.content as any[])[0].text.replace(/\s+/g, ' ')}`);

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
