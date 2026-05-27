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
