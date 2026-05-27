/**
 * TMP smoke test — boots against a running slushy.trade-mcp and proves:
 *   1. unauthenticated connect is rejected
 *   2. an allowlisted wallet's Bearer token connects (initialize handshake)
 *   3. tools/list returns the expected tools
 *   4. resources/list returns the streaming resources
 *   5. (if HyPaper is up) get_all_mids returns market data
 * Throwaway.
 */
import { ethers } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:8788/mcp';
const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // hardhat #0

function mcpAccessMessage(a: string) { return `slushy.trade MCP access\nwallet: ${a.toLowerCase()}`; }

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); ok ? pass++ : fail++; };

async function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  const client = new Client({ name: 'smoke', version: '0' });
  await client.connect(transport);
  return client;
}

(async () => {
  // 1. no auth → rejected
  try { await connect(); check('unauth rejected', false, 'connected without a token (should fail)'); }
  catch (e) { check('unauth rejected', true, String((e as Error).message).slice(0, 100)); }

  // mint token for the allowlisted wallet
  const w = new ethers.Wallet(PK);
  const sig = await w.signMessage(mcpAccessMessage(w.address));
  const token = Buffer.from(JSON.stringify({ address: w.address, signature: sig })).toString('base64url');

  // 2 + 3 + 4
  const client = await connect(token);
  check('authed connect (allowlisted)', true, `session established as ${w.address}`);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  const want = ['get_account', 'place_order', 'cancel_order', 'get_all_mids', 'set_leverage', 'get_supporter_status'];
  check('tools/list', want.every((t) => tools.includes(t)), `${tools.length} tools: ${tools.join(', ')}`);

  const resources = (await client.listResources()).resources.map((r) => r.uri);
  check('resources/list', resources.includes('slushy://mids'), `${resources.length}: ${resources.join(', ')}`);

  // 5. optional HyPaper-backed tool
  try {
    const r = await client.callTool({ name: 'get_all_mids', arguments: {} });
    const txt = (r.content as any[])?.[0]?.text ?? '';
    const ok = !r.isError && txt.length > 2;
    check('get_all_mids (needs HyPaper up)', ok, ok ? `${txt.length} bytes of mids` : `err: ${txt.slice(0, 120)}`);
  } catch (e) { check('get_all_mids (needs HyPaper up)', false, `(HyPaper likely down) ${String((e as Error).message).slice(0, 100)}`); }

  await client.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
