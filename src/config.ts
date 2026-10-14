import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

// Public origin this server is reached at (through nginx). OAuth metadata,
// the authorization/token endpoints, and the protected-resource id are all
// derived from it, so it MUST match what clients hit (prod: https://slushy.trade).
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? 'https://slushy.trade').replace(/\/$/, '');

export const config = {
  port: Number.parseInt(process.env.PORT ?? '8788', 10),
  host: process.env.HOST ?? '127.0.0.1',

  // OAuth 2.1 (so the ChatGPT app + one-click Claude Desktop can connect).
  // The issuer/AS and the resource live on the same origin behind nginx.
  publicBaseUrl,
  mcpResourceUrl: `${publicBaseUrl}/mcp`,
  // Where the browser is sent to consent (connect wallet + sign). The slushy
  // SPA renders the consent screen when it sees `?mcp_authorize=<id>`.
  consentUrl: (process.env.SLUSHY_CONSENT_URL ?? publicBaseUrl).replace(/\/$/, ''),

  // HyPaper backend this MCP server proxies.
  hypaperHttpUrl: (process.env.HYPAPER_HTTP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  // Presented to HyPaper on every request so its unsigned `{wallet}`
  // /exchange path and /hypaper admin actions accept us. Required: without
  // it HyPaper (correctly) refuses every unsigned action.
  hypaperInternalSecret: required('HYPAPER_INTERNAL_SECRET'),
  // HMAC key for short-lived delegate tokens handed to LLM vendors during
  // a chat (src/auth.ts). Required so the forwarded credential is never
  // the user's own wallet token.
  delegateSecret: required('MCP_DELEGATE_SECRET'),
  // Browser origins allowed to call the HTTP routes. Reflecting any Origin
  // removed origin as a barrier once a token leaked (2026-10-13, M18).
  corsOrigins: new Set(
    (process.env.CORS_ORIGINS ?? `${publicBaseUrl},http://localhost:5173`)
      .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  ),
  hypaperWsUrl: process.env.HYPAPER_WS_URL ?? 'ws://localhost:3000/ws',

  // Real Hyperliquid /info — used for LIVE-mode user reads (account, positions,
  // orders, fills) keyed by the wallet address. Public endpoint, no auth.
  hlInfoUrl: (process.env.HL_INFO_URL ?? 'https://api.hyperliquid.xyz').replace(/\/$/, ''),

  // Black Owl hl-triggers-tracker daemon — IP-allowlisted endpoint that
  // serves the per-asset open trigger order ledger out of the periodic
  // ABCI state snapshots. Public clients can't reach this; the prod box
  // hosting slushy-trade-mcp must already be on the daemon's UFW allowlist
  // (same allow rules as the slushy.trade frontend). Source:
  // hl-websocket-bridge-config/bridge/hl-triggers-tracker.py.
  bracketTrackerUrl: (process.env.BRACKET_TRACKER_URL ?? 'http://142.91.109.191:3004').replace(/\/$/, ''),

  // Active-supporter gate. `SUPPORTER_CONTRACT` is the deployed
  // AdFreeSubscription contract on Arbitrum (named pre-rename; can't be
  // renamed on-chain). We read its `isPaidAdFree(address)` view.
  supporterContract: required('SUPPORTER_CONTRACT'),
  // VerifiedExecutiveAccess on HyperEVM — GRANDFATHERED access for the
  // executive team (slushAI + MCP tokens only; it grants nothing else
  // since the 2026-09-25 decoupling of live mode from paid perks).
  venContract: process.env.VEN_CONTRACT ?? '0x01A36bA46BB973A87353c07392191476F18c2fdE',
  hyperevmRpc: process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm',
  arbitrumRpc: process.env.ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc',

  // Verified-executive access — VerifiedExecutiveAccess contract on HyperEVM.
  // `verified(addr)` holders also get MCP access (same gate slushy uses for
  // its live-mode toggle).

  supporterCacheTtlMs: Number.parseInt(process.env.SUPPORTER_CACHE_TTL_SECONDS ?? '60', 10) * 1000,
  supporterAllowlist: new Set(
    (process.env.SUPPORTER_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
};
