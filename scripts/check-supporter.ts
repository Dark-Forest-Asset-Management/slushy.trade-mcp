/**
 * Real on-chain supporter check (no private key needed — it's a read).
 *   npx tsx scripts/check-supporter.ts 0x<address>
 * Hits the configured SUPPORTER_CONTRACT / ARBITRUM_RPC. Run with
 * SUPPORTER_ALLOWLIST= to force the on-chain read (ignore the allowlist).
 */
import { getSupporterStatus } from '../src/supporter.js';

const addr = process.argv[2];
if (!addr) { console.error('Usage: npx tsx scripts/check-supporter.ts 0x<address>'); process.exit(1); }

(async () => {
  const s = await getSupporterStatus(addr);
  console.log(JSON.stringify({
    address: addr,
    active: s.active,
    expiresAt: s.expiresAt,
    expiresAtISO: s.expiresAt ? new Date(s.expiresAt * 1000).toISOString() : null,
  }, null, 2));
})().catch((e) => { console.error('check failed:', e.message); process.exit(2); });
