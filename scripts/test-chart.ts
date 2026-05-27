/**
 * TMP — verify path 2: POST a PNG to /chart (supporter-gated), then fetch it
 * back via the get_chart_image MCP tool and confirm the bytes round-trip.
 *   MCP_TOKEN=<token> npx tsx scripts/test-chart.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8788';
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) { console.error('MCP_TOKEN=<token> npx tsx scripts/test-chart.ts'); process.exit(1); }
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

(async () => {
  const png = Buffer.from(PNG_B64, 'base64');
  const up = await fetch(`${BASE}/chart`, { method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${TOKEN}` }, body: png });
  const upj = await up.json() as any;
  check('POST /chart (supporter-gated upload)', up.ok && upj.ok === true && upj.bytes === png.length, JSON.stringify(upj));

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'chart-test', version: '0' });
  await client.connect(transport);
  const r = await client.callTool({ name: 'get_chart_image', arguments: {} });
  const img = (r.content as any[]).find((c) => c.type === 'image');
  check('get_chart_image returns an image block', !!img && img.mimeType === 'image/png', img ? `mime=${img.mimeType}, ${img.data.length} b64 chars` : JSON.stringify(r.content).slice(0, 150));
  check('round-trip bytes match upload', img?.data === PNG_B64, img ? `equal=${img.data === PNG_B64}` : 'no image returned');
  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
