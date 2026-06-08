/**
 * Thin HTTP client for the Black Owl hl-triggers-tracker daemon (port 3004
 * on the Tokyo HL non-validator). The daemon streams the per-asset open
 * trigger order ledger out of the periodic ABCI state snapshots — see
 * hl-websocket-bridge-config/bridge/hl-triggers-tracker.py for the parser
 * details. Source data refreshes every ~11 minutes (HL's
 * periodic_abci_states cadence); the MCP tools surface the
 * `snapshot_age_ms` field so callers can reason about staleness.
 *
 * The MCP server must be on the daemon's UFW allowlist for the wire to
 * work in prod (slushy.trade prod IP needs the same allow that the
 * frontend gets — see hl-websocket-bridge-config/ufw/setup-firewall.sh).
 */

import { config } from './config.js';

export interface BracketLeg {
  /** EVM wallet placing the trigger. */
  addr: string;
  /** Hyperliquid order id. */
  oid: number;
  /** HL bracket-UI label for this leg — NOT a profit/loss state. */
  kind: 'tp' | 'sl';
  /** 'A' = ask-side (sell-trigger → closes a long).
   *  'B' = bid-side (buy-trigger → closes a short). */
  side: 'A' | 'B';
  /** USD price at which the trigger fires. */
  trigger_px: number | null;
  /** USD limit price the trigger places (or market if is_market=true). */
  limit_px: number | null;
  /** USD entry price of the wallet's underlying position on this asset,
   *  joined from the periodic ABCI position record (entry_notional / size).
   *  Null when the wallet has no open position — i.e. the trigger is an
   *  orphaned reduce-only order. */
  entry_px: number | null;
  /** Order size in human units (raw / 10^szDecimals). */
  size: number;
  /** Where `size` came from:
   *   - "explicit"  → set on the order itself (HL bracket-UI placements).
   *   - "position"  → filled in from the wallet's open position size
   *                   when the order had no explicit size.
   *   - "unknown"   → orphan (no position, no explicit size) — size: 0. */
  size_source: 'explicit' | 'position' | 'unknown';
  reduce_only: boolean;
  is_market: boolean;
  /** Wall-clock ms when the order was placed. */
  placed_ms: number;
  /** "oco" if the same (addr, asset) also has the opposite-kind leg open
   *  on this asset (i.e. a full tp+sl pair), else null. */
  bracket: 'oco' | null;
}

export interface BracketSnapshot {
  asset_id: number;
  asset_name: string;
  sz_decimals: number;
  /** Last trade price for the asset, in USD. */
  mid_usd: number | null;
  /** ABCI block at which the snapshot was taken. */
  snapshot_block: number;
  /** Milliseconds since the daemon loaded this snapshot — caps the
   *  freshness of the data. Snapshots cycle every ~11 min. */
  snapshot_age_ms: number;
  legs: BracketLeg[];
}

/** Returns the daemon's response unmodified, or throws on non-2xx. */
export async function fetchBracketSnapshot(coin: string): Promise<BracketSnapshot> {
  const url = `${config.bracketTrackerUrl}/triggers/${encodeURIComponent(coin.toUpperCase())}`;
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) {
    // 503 = snapshot still loading on a fresh start (~90 s cold boot).
    // Surface it verbatim so the caller can choose to retry instead of
    // failing the whole tool with a generic message.
    throw new Error(`bracket-tracker ${url} HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as BracketSnapshot;
  } catch {
    throw new Error(`bracket-tracker ${url} non-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`);
  }
}
