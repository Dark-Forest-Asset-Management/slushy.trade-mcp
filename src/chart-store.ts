/**
 * Per-wallet cache of the latest chart screenshot a user exported from slushy.
 *
 * The PNG is rendered in the browser (chart + drawings) and POSTed to
 * `/chart`; an MCP `get_chart_image` tool then returns it as image content for
 * visual analysis. One latest image per wallet, kept in memory, bounded.
 */

interface ChartEntry { data: Buffer; mimeType: string; at: number; }

const store = new Map<string, ChartEntry>();
const MAX_WALLETS = 200;

export function setChart(wallet: string, data: Buffer, mimeType: string): void {
  store.set(wallet.toLowerCase(), { data, mimeType, at: Date.now() });
  if (store.size > MAX_WALLETS) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of store) if (v.at < oldest) { oldest = v.at; oldestKey = k; }
    if (oldestKey) store.delete(oldestKey);
  }
}

export function getChart(wallet: string): ChartEntry | undefined {
  return store.get(wallet.toLowerCase());
}

// ── drawings (vector JSON pushed alongside the PNG) ──────────────────────
interface DrawingsEntry { data: unknown; at: number; }
const drawings = new Map<string, DrawingsEntry>();

export function setDrawings(wallet: string, data: unknown): void {
  drawings.set(wallet.toLowerCase(), { data, at: Date.now() });
  if (drawings.size > MAX_WALLETS) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of drawings) if (v.at < oldest) { oldest = v.at; oldestKey = k; }
    if (oldestKey) drawings.delete(oldestKey);
  }
}

export function getDrawings(wallet: string): DrawingsEntry | undefined {
  return drawings.get(wallet.toLowerCase());
}

// ── agent-authored drawings (the AI annotates the user's chart) ──────────
// add_chart_drawing appends here; the slushy frontend polls GET /agent-drawings
// and importDrawings()-renders them. clear_chart_drawings empties it.
const agentDrawings = new Map<string, unknown[]>();

export function addAgentDrawing(wallet: string, drawing: unknown): number {
  const key = wallet.toLowerCase();
  const list = agentDrawings.get(key) ?? [];
  list.push(drawing);
  agentDrawings.set(key, list);
  return list.length;
}

export function getAgentDrawings(wallet: string): unknown[] {
  return agentDrawings.get(wallet.toLowerCase()) ?? [];
}

export function clearAgentDrawings(wallet: string): number {
  const key = wallet.toLowerCase();
  const n = agentDrawings.get(key)?.length ?? 0;
  agentDrawings.delete(key);
  return n;
}

// Opt-in "clear the USER's own drawings" command. A monotonic counter per
// wallet; the slushy poll clears the user's drawings once when it sees the
// counter increase. Destructive, so only bumped when explicitly requested.
const clearUserSignal = new Map<string, number>();

export function bumpClearUserDrawings(wallet: string): number {
  const key = wallet.toLowerCase();
  const next = (clearUserSignal.get(key) ?? 0) + 1;
  clearUserSignal.set(key, next);
  return next;
}

export function getClearUserSignal(wallet: string): number {
  return clearUserSignal.get(wallet.toLowerCase()) ?? 0;
}
