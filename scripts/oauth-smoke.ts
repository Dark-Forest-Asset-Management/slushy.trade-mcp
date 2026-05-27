/**
 * TMP smoke test for the OAuth 2.1 flow. Throwaway.
 *
 * Mocks ONLY the external RPC (so the gate reports "supporter"), then drives
 * the real endpoints end to end against a locally-booted app:
 *   discovery → dynamic registration → /authorize (PKCE) → consent complete
 *   (real wallet signature) → /token → and proves the issued access_token is
 *   accepted by the resource server's authenticate().
 *
 *   PORT=8799 npx tsx scripts/oauth-smoke.ts
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { ethers } from 'ethers';

const PORT = Number(process.env.PORT ?? 8799);
const RPC_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

// ─── 1. Mock JSON-RPC: every eth_call → 1 (true) so the gate says "supporter".
const TRUE_WORD = '0x' + '0'.repeat(63) + '1';
function rpcResult(method: string): string {
  if (method === 'eth_chainId') return '0xa4b1';
  if (method === 'eth_blockNumber') return '0x1';
  if (method === 'eth_call') return TRUE_WORD;
  return '0x';
}
const rpc = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const handle = (m: { id: unknown; method: string }) => ({ jsonrpc: '2.0', id: m.id, result: rpcResult(m.method) });
    const out = Array.isArray(body) ? body.map(handle) : handle(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
  ok ? pass++ : fail++;
};

(async () => {
  await new Promise<void>((r) => rpc.listen(RPC_PORT, r));

  // Env MUST be set before importing config.ts (read at import).
  process.env.PUBLIC_BASE_URL = BASE;
  process.env.SLUSHY_CONSENT_URL = 'http://127.0.0.1:9999';
  process.env.SUPPORTER_CONTRACT = '0x8ea4260D7017b68eB8456Af5122729080cd5a6e5';
  process.env.VEN_CONTRACT = '0x01A36bA46BB973A87353c07392191476F18c2fdE';
  process.env.ARBITRUM_RPC = RPC_URL;
  process.env.HYPEREVM_RPC = RPC_URL;

  const { createApp } = await import('../src/server.js');
  const { authenticate } = await import('../src/auth.js');
  const { mcpAccessMessage } = await import('../src/auth.js');
  const { app } = createApp();
  const server = app.listen(PORT);
  await new Promise<void>((r) => server.on('listening', () => r()));

  const json = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    let body: unknown; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, headers: res.headers, body: body as any };
  };

  // 2. Discovery
  const prm = await json('/.well-known/oauth-protected-resource');
  check('protected-resource metadata', prm.body?.resource === `${BASE}/mcp` && prm.body?.authorization_servers?.[0] === BASE,
    JSON.stringify(prm.body));
  const asm = await json('/.well-known/oauth-authorization-server');
  check('authorization-server metadata',
    asm.body?.authorization_endpoint === `${BASE}/oauth/authorize` &&
    asm.body?.token_endpoint === `${BASE}/oauth/token` &&
    asm.body?.code_challenge_methods_supported?.includes('S256'),
    JSON.stringify(asm.body));

  // WWW-Authenticate challenge on unauthenticated /mcp initialize
  const initProbe = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }),
  });
  check('401 + WWW-Authenticate on /mcp', initProbe.status === 401 && /resource_metadata=/.test(initProbe.headers.get('www-authenticate') ?? ''),
    `status=${initProbe.status} hdr=${initProbe.headers.get('www-authenticate')}`);

  // 3. Dynamic client registration
  const redirectUri = 'http://localhost:9999/callback';
  const reg = await json('/oauth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'smoke-client' }),
  });
  const clientId = reg.body?.client_id as string;
  check('dynamic client registration', reg.status === 201 && typeof clientId === 'string' && clientId.startsWith('mcp_'),
    `status=${reg.status} client_id=${clientId}`);

  // 4. /authorize with PKCE → 302 to consent page
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}&code_challenge_method=S256&state=st-123&scope=mcp&resource=${encodeURIComponent(BASE + '/mcp')}`;
  const authRes = await fetch(`${BASE}${authUrl}`, { redirect: 'manual' });
  const loc = authRes.headers.get('location') ?? '';
  const authzId = new URL(loc).searchParams.get('mcp_authorize') ?? '';
  check('/authorize → consent redirect', authRes.status === 302 && loc.startsWith('http://127.0.0.1:9999/') && !!authzId,
    `status=${authRes.status} loc=${loc}`);

  // 5. consent page reads who's asking
  const info = await json(`/oauth/authorize/info?authzId=${authzId}`);
  check('/authorize/info', info.body?.clientName === 'smoke-client' && info.body?.redirectUri === redirectUri, JSON.stringify(info.body));

  // 6. consent completes with a REAL wallet signature
  const wallet = ethers.Wallet.createRandom();
  const sig = await wallet.signMessage(mcpAccessMessage(wallet.address));
  const walletToken = Buffer.from(JSON.stringify({ address: wallet.address, signature: sig })).toString('base64url');
  const complete = await json('/oauth/authorize/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authzId, token: walletToken }),
  });
  const cbUrl = new URL(complete.body?.redirectTo ?? 'http://x/');
  const code = cbUrl.searchParams.get('code') ?? '';
  check('/authorize/complete → code', complete.status === 200 && cbUrl.origin + cbUrl.pathname === redirectUri && cbUrl.searchParams.get('state') === 'st-123' && !!code,
    `redirectTo=${complete.body?.redirectTo}`);

  // 7. token exchange (PKCE) → access_token === the wallet token
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId });
  const tok = await json('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  check('/token → access_token', tok.status === 200 && tok.body?.token_type === 'Bearer' && tok.body?.access_token === walletToken,
    `status=${tok.status} match=${tok.body?.access_token === walletToken}`);

  // 8. issued token is accepted by the resource server
  const verified = await authenticate(`Bearer ${tok.body?.access_token}`);
  check('access_token accepted by authenticate()', verified.ok === true && verified.wallet === wallet.address.toLowerCase(),
    JSON.stringify(verified));

  // 9. negatives: code is single-use; PKCE must match
  const reuse = await json('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  check('code single-use', reuse.status === 400 && reuse.body?.error === 'invalid_grant', JSON.stringify(reuse.body));

  // fresh code, wrong verifier
  const a2 = await fetch(`${BASE}${authUrl.replace('st-123', 'st-2')}`, { redirect: 'manual' });
  const id2 = new URL(a2.headers.get('location') ?? '').searchParams.get('mcp_authorize') ?? '';
  const c2 = await json('/oauth/authorize/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authzId: id2, token: walletToken }) });
  const code2 = new URL(c2.body?.redirectTo ?? 'http://x/').searchParams.get('code') ?? '';
  const badForm = new URLSearchParams({ grant_type: 'authorization_code', code: code2, code_verifier: 'wrong-verifier', redirect_uri: redirectUri, client_id: clientId });
  const badTok = await json('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: badForm.toString() });
  check('PKCE mismatch rejected', badTok.status === 400 && badTok.body?.error === 'invalid_grant', JSON.stringify(badTok.body));

  // unregistered redirect_uri rejected (no open redirect)
  const badRedir = await fetch(`${BASE}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent('http://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: 'manual' });
  check('unregistered redirect_uri rejected', badRedir.status === 400, `status=${badRedir.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); rpc.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
