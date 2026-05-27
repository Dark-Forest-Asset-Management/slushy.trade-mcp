/** TMP — pull the pushed chart image (→file) + drawings (→stdout). MCP_TOKEN env. */
import { writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = 'http://127.0.0.1:8788';
const OUT = process.argv[2] ?? '/tmp/slushy-chart.png';

(async () => {
  const t = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_TOKEN}` } } });
  const client = new Client({ name: 'pull', version: '0' });
  await client.connect(t);

  const img = await client.callTool({ name: 'get_chart_image', arguments: {} });
  const imgBlock = (img.content as any[]).find((c) => c.type === 'image');
  if (imgBlock) { writeFileSync(OUT, Buffer.from(imgBlock.data, 'base64')); console.log(`image: wrote ${OUT} (${Buffer.from(imgBlock.data, 'base64').length} bytes, ${imgBlock.mimeType})`); }
  else console.log('image:', (img.content as any[])[0]?.text);

  const d = await client.callTool({ name: 'get_chart_drawings', arguments: {} });
  console.log('drawings:', (d.content as any[])[0]?.text?.slice(0, 1500));

  await client.close();
})().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
