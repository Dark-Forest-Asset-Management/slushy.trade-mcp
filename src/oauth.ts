/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * Why this exists: the ChatGPT app's connector UI (and Claude Desktop's
 * one-click "Custom Connector") only speak OAuth — they refuse static bearer
 * tokens. So we wrap the wallet-signature auth we already have in the standard
 * MCP OAuth flow:
 *
 *   1. Client discovers us via /.well-known/oauth-protected-resource.
 *   2. Client self-registers (RFC 7591 dynamic registration) → client_id.
 *   3. Client opens /oauth/authorize (browser) with PKCE. We bounce the
 *      browser to the slushy consent page (?mcp_authorize=<id>), which
 *      connects the wallet, signs the SAME access message, and POSTs the
 *      resulting token back to /oauth/authorize/complete.
 *   4. We verify the token (recover signer + on-chain supporter gate) and
 *      mint a short-lived, single-use authorization code.
 *   5. Client exchanges the code (+ PKCE verifier) at /oauth/token.
 *
 * The access_token we hand back IS the existing self-authenticating
 * wallet-signature token — so the resource server (auth.ts) verifies it
 * unchanged, and a server restart never invalidates a live client (the token
 * carries its own proof; the on-chain gate is the real expiry).
 *
 * State:
 *   - `clients` (RFC 7591 registrations)  PERSISTED to disk. ChatGPT and
 *      Claude Desktop cache their client_id and reuse it across our restarts;
 *      losing the registry returns "Unknown client_id — register first." and
 *      breaks every cached connector until the user removes + re-adds it.
 *   - `pending` (~10-min PKCE state) and `codes` (~60-s single-use)
 *      stay in-memory. Their TTLs are short enough that a restart mid-flow
 *      just costs the user one retry.
 *   - Issued access_tokens are the existing self-authenticating wallet
 *      tokens — they never lived on the server, so restarts can't invalidate
 *      a live session.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { authenticate } from './auth.js';
import { config } from './config.js';

const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

interface ClientReg {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}
interface PendingAuthz {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope?: string;
  resource?: string;
  clientName?: string;
  createdAt: number;
}
interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  walletToken: string; // the self-auth bearer token returned as access_token
  createdAt: number;
}

// ─── Client-registry persistence ────────────────────────────────────
// State dir defaults to /var/lib/slushy-trade-mcp (use systemd's
// StateDirectory= to provision it with the right owner). Override with
// MCP_STATE_DIR for local dev. The file is written via tmp+rename so a
// crash mid-write can never leave a corrupt registry.
const STATE_DIR = process.env.MCP_STATE_DIR ?? '/var/lib/slushy-trade-mcp';
const CLIENTS_FILE = join(STATE_DIR, 'clients.json');

function loadClients(): Map<string, ClientReg> {
  try {
    if (!existsSync(CLIENTS_FILE)) return new Map();
    const arr = JSON.parse(readFileSync(CLIENTS_FILE, 'utf8')) as ClientReg[];
    if (!Array.isArray(arr)) return new Map();
    return new Map(arr.filter((c) => c && typeof c.clientId === 'string').map((c) => [c.clientId, c]));
  } catch (err) {
    console.error(`[oauth] failed to load ${CLIENTS_FILE}, starting empty:`, (err as Error).message);
    return new Map();
  }
}

function persistClients() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const tmp = CLIENTS_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify([...clients.values()], null, 2), 'utf8');
    renameSync(tmp, CLIENTS_FILE);
  } catch (err) {
    console.error(`[oauth] failed to persist ${CLIENTS_FILE}:`, (err as Error).message);
  }
}

const clients = loadClients();
const pending = new Map<string, PendingAuthz>();
const codes = new Map<string, AuthCode>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(k);
  for (const [k, v] of codes) if (now - v.createdAt > CODE_TTL_MS) codes.delete(k);
}, 60_000).unref?.();

// ─── Discovery documents ────────────────────────────────────────────

export function protectedResourceMetadata() {
  return {
    resource: config.mcpResourceUrl,
    authorization_servers: [config.publicBaseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  };
}

export function authorizationServerMetadata() {
  const base = config.publicBaseUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  };
}

// ─── Dynamic client registration (RFC 7591) ─────────────────────────

type RegBody = { redirect_uris?: unknown; client_name?: unknown };

export function registerClient(body: RegBody):
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; error: string; error_description: string } {
  const redirectUris = Array.isArray(body?.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
    : [];
  if (redirectUris.length === 0) {
    return { ok: false, error: 'invalid_redirect_uri', error_description: 'At least one http(s) redirect_uri is required.' };
  }
  const clientId = `mcp_${randomBytes(16).toString('hex')}`;
  const clientName = typeof body?.client_name === 'string' ? body.client_name : undefined;
  const reg: ClientReg = { clientId, redirectUris, clientName, createdAt: Date.now() };
  clients.set(clientId, reg);
  persistClients();  // ChatGPT/Claude cache this client_id across our restarts
  return {
    ok: true,
    doc: {
      client_id: clientId,
      client_id_issued_at: Math.floor(reg.createdAt / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      ...(clientName ? { client_name: clientName } : {}),
    },
  };
}

// ─── Authorize (step 3) ─────────────────────────────────────────────

type Query = Record<string, string | undefined>;

export type StartAuthorizeResult =
  | { kind: 'redirect'; url: string }                        // → slushy consent page
  | { kind: 'error_redirect'; url: string }                  // → client redirect_uri with error
  | { kind: 'error'; status: number; error: string };        // → render here (untrusted redirect)

export function startAuthorize(q: Query): StartAuthorizeResult {
  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;
  if (!clientId) return { kind: 'error', status: 400, error: 'client_id is required' };
  const client = clients.get(clientId);
  if (!client) return { kind: 'error', status: 400, error: 'Unknown client_id — register first.' };
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { kind: 'error', status: 400, error: 'redirect_uri does not match a registered URI.' };
  }
  // From here the redirect_uri is trusted, so spec errors go back to it.
  const fail = (error: string, desc: string): StartAuthorizeResult => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', desc);
    if (q.state) u.searchParams.set('state', q.state);
    return { kind: 'error_redirect', url: u.toString() };
  };
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
  if (!q.code_challenge || (q.code_challenge_method ?? 'plain') !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
  }

  const authzId = randomUUID();
  pending.set(authzId, {
    clientId,
    redirectUri,
    codeChallenge: q.code_challenge,
    state: q.state,
    scope: q.scope,
    resource: q.resource,
    clientName: client.clientName,
    createdAt: Date.now(),
  });
  const url = new URL(`${config.consentUrl}/`);
  url.searchParams.set('mcp_authorize', authzId);
  return { kind: 'redirect', url: url.toString() };
}

/** Details the consent page shows the user ("Authorize <X> to access…"). */
export function authorizeInfo(authzId: string): { clientName: string | null; redirectUri: string; scope: string } | null {
  const p = pending.get(authzId);
  if (!p) return null;
  return { clientName: p.clientName ?? null, redirectUri: p.redirectUri, scope: p.scope ?? 'mcp' };
}

/** Called by the slushy consent page after the wallet signs. `walletToken` is
 *  the bare self-auth token (no "Bearer " prefix). On success returns the URL
 *  to send the browser back to (the client's redirect_uri with ?code=). */
export async function completeAuthorize(authzId: string, walletToken: string):
  Promise<{ ok: true; redirectTo: string } | { ok: false; status: number; error: string }> {
  const p = pending.get(authzId);
  if (!p) return { ok: false, status: 400, error: 'Unknown or expired authorization request.' };

  const auth = await authenticate(`Bearer ${walletToken}`);
  if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };

  pending.delete(authzId);
  const code = randomBytes(24).toString('base64url');
  codes.set(code, {
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    codeChallenge: p.codeChallenge,
    walletToken,
    createdAt: Date.now(),
  });
  const redir = new URL(p.redirectUri);
  redir.searchParams.set('code', code);
  if (p.state) redir.searchParams.set('state', p.state);
  return { ok: true, redirectTo: redir.toString() };
}

// ─── Token (step 5) ─────────────────────────────────────────────────

export function exchangeToken(body: Query):
  | { ok: true; token: { access_token: string; token_type: 'Bearer'; scope: string } }
  | { ok: false; status: number; error: string; error_description?: string } {
  if (body.grant_type !== 'authorization_code') {
    return { ok: false, status: 400, error: 'unsupported_grant_type', error_description: 'Only authorization_code is supported.' };
  }
  const code = body.code;
  if (!code) return { ok: false, status: 400, error: 'invalid_request', error_description: 'code is required.' };
  const rec = codes.get(code);
  // Single-use: delete on first lookup regardless of outcome.
  if (rec) codes.delete(code);
  if (!rec || Date.now() - rec.createdAt > CODE_TTL_MS) {
    return { ok: false, status: 400, error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' };
  }
  if (body.client_id && body.client_id !== rec.clientId) {
    return { ok: false, status: 400, error: 'invalid_grant', error_description: 'client_id mismatch.' };
  }
  if (body.redirect_uri && body.redirect_uri !== rec.redirectUri) {
    return { ok: false, status: 400, error: 'invalid_grant', error_description: 'redirect_uri mismatch.' };
  }
  if (!body.code_verifier) {
    return { ok: false, status: 400, error: 'invalid_request', error_description: 'code_verifier is required.' };
  }
  const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
  if (challenge !== rec.codeChallenge) {
    return { ok: false, status: 400, error: 'invalid_grant', error_description: 'PKCE verification failed.' };
  }
  return { ok: true, token: { access_token: rec.walletToken, token_type: 'Bearer', scope: 'mcp' } };
}
