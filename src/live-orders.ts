/**
 * Pending live-order queue (Part B of live mode).
 *
 * The MCP server can't sign HL actions (it holds no key). So in LIVE mode a
 * trade tool does NOT execute — it QUEUES the unsigned HL action here and tells
 * the agent to confirm at slushy.trade. The slushy browser (which holds the
 * wallet key) polls GET /live-pending, shows a confirm/deny modal, and on
 * confirm signs the action (signL1Action) + submits it to real HL, then
 * resolves the entry. Nothing here ever touches a key or submits an order.
 *
 * In-memory + per-wallet + short TTL: a queued order the user never confirms
 * simply expires. Survives nothing on restart by design (an unconfirmed order
 * is not a commitment).
 */

import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;

export interface PendingLiveOrder {
  id: string;
  wallet: string;
  /** Human summary the confirm modal + agent message show (e.g. "Buy 0.1 BTC @ 73,500, GTC"). */
  summary: string;
  /** The HL exchange action(s) to sign + submit verbatim on confirm. Opaque to
   *  the server; the browser signs exactly this. */
  action: unknown;
  createdAt: number;
}

// wallet(lowercased) → its pending orders.
const byWallet = new Map<string, PendingLiveOrder[]>();

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [w, list] of byWallet) {
    const live = list.filter((o) => o.createdAt >= cutoff);
    if (live.length === 0) byWallet.delete(w);
    else if (live.length !== list.length) byWallet.set(w, live);
  }
}
setInterval(sweep, 60_000).unref?.();

/** Queue an unsigned live action for the user to confirm in slushy. Returns the
 *  pending id + the current pending count for that wallet. */
export function queueLiveOrder(wallet: string, summary: string, action: unknown): { id: string; pending: number } {
  const w = wallet.toLowerCase();
  const id = randomUUID();
  const list = byWallet.get(w) ?? [];
  list.push({ id, wallet: w, summary, action, createdAt: Date.now() });
  byWallet.set(w, list);
  return { id, pending: list.length };
}

/** Non-expired pending orders for a wallet (what the slushy modal renders). */
export function getPendingLiveOrders(wallet: string): PendingLiveOrder[] {
  const cutoff = Date.now() - TTL_MS;
  return (byWallet.get(wallet.toLowerCase()) ?? []).filter((o) => o.createdAt >= cutoff);
}

/** Remove a pending order once the browser has confirmed (signed + submitted)
 *  or denied it. Returns true if it existed. */
export function resolveLiveOrder(wallet: string, id: string): boolean {
  const w = wallet.toLowerCase();
  const list = byWallet.get(w);
  if (!list) return false;
  const next = list.filter((o) => o.id !== id);
  if (next.length === list.length) return false;
  if (next.length === 0) byWallet.delete(w); else byWallet.set(w, next);
  return true;
}
