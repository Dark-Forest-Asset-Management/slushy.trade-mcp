import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

export const config = {
  port: Number.parseInt(process.env.PORT ?? '8788', 10),
  host: process.env.HOST ?? '127.0.0.1',

  // HyPaper backend this MCP server proxies.
  hypaperHttpUrl: (process.env.HYPAPER_HTTP_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
  hypaperWsUrl: process.env.HYPAPER_WS_URL ?? 'ws://localhost:3000/ws',

  // Active-supporter gate. `SUPPORTER_CONTRACT` is the deployed
  // AdFreeSubscription contract on Arbitrum (named pre-rename; can't be
  // renamed on-chain). We read its `isPaidAdFree(address)` view.
  supporterContract: required('SUPPORTER_CONTRACT'),
  arbitrumRpc: process.env.ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc',

  // Verified-executive access — VerifiedExecutiveAccess contract on HyperEVM.
  // `verified(addr)` holders also get MCP access (same gate slushy uses for
  // its live-mode toggle).
  venContract: process.env.VEN_CONTRACT ?? '0x01A36bA46BB973A87353c07392191476F18c2fdE',
  hyperevmRpc: process.env.HYPEREVM_RPC ?? 'https://rpc.hyperliquid.xyz/evm',

  supporterCacheTtlMs: Number.parseInt(process.env.SUPPORTER_CACHE_TTL_SECONDS ?? '60', 10) * 1000,
  supporterAllowlist: new Set(
    (process.env.SUPPORTER_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ),
};
