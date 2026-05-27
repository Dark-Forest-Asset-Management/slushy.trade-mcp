/** TMP — fetch get_chart_image and write it to a file so it can be viewed. */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const TOKEN = process.env.MCP_TOKEN!;
const OUT = process.argv[2] ?? '/tmp/slushy-chart.png';

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
  const client = new Client({ name: 'save-chart', version: '0' });
  await client.connect(t);
  const r = await client.callTool({ name: 'get_chart_image', arguments: {} });
  const img = (r.content as any[]).find((c) => c.type === 'image');
  if (!img) { console.log('NO IMAGE:', JSON.stringify(r.content).slice(0, 200)); process.exit(1); }
  const buf = Buffer.from(img.data, 'base64');
  writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${buf.length} bytes, ${img.mimeType})`);
  await client.close();
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
