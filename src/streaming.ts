/**
 * Streaming: bridges HyPaper's WebSocket feeds to MCP resource subscriptions.
 *
 * Each session opens ONE upstream WS to HyPaper (lazily, on first subscribe).
 * Resources expose live feeds; a client `resources/read` returns the latest
 * cached frame, and on every new frame we send `notifications/resources/updated`
 * so a subscribed client re-reads. This is the standard MCP push pattern for
 * full clients (Claude Desktop/Code). Wallet-scoped feeds are pinned to the
 * session's authenticated wallet.
 *
 * URIs:
 *   slushy://mids                 allMids
 *   slushy://l2/{coin}            l2Book for {coin}
 *   slushy://trades/{coin}        trades for {coin}
 *   slushy://account              webData2 (positions + open orders)
 *   slushy://fills                your fills
 *   slushy://orders               your order updates
 *
 * NOTE: the resources/subscribe → sendResourceUpdated wiring uses the
 * low-level server handlers — smoke-test against the installed SDK (1.29).
 */

import WebSocket from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';

interface FeedKey { uri: string; sub: object; }

export class SessionStreams {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  /** uri → latest frame data (for resources/read). */
  private latest = new Map<string, unknown>();
  /** HyPaper subscription objects we've sent upstream, keyed by uri. */
  private active = new Map<string, object>();

  constructor(private server: McpServer, private wallet: string) {}

  // ── upstream WS lifecycle ──────────────────────────────────────────────
  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(config.hypaperWsUrl);
      this.ws = ws;
      ws.on('open', () => { resolve(); });
      ws.on('message', (raw: WebSocket.RawData) => this.onFrame(raw));
      ws.on('error', (err) => reject(err));
      ws.on('close', () => { this.ws = null; });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Map an inbound HyPaper frame to one of our resource URIs + cache it,
   *  then notify subscribers. */
  private onFrame(raw: WebSocket.RawData): void {
    let msg: { channel?: string; data?: any };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg.channel) return;
    const uri = this.uriForChannel(msg.channel, msg.data);
    if (!uri) return;
    this.latest.set(uri, msg.data);
    // Tell subscribed clients the resource changed; they re-read to get it.
    void this.server.server.sendResourceUpdated({ uri }).catch(() => {});
  }

  private uriForChannel(channel: string, data: any): string | null {
    switch (channel) {
      case 'allMids': return 'slushy://mids';
      case 'l2Book': return data?.coin ? `slushy://l2/${data.coin}` : null;
      case 'trades': return Array.isArray(data) && data[0]?.coin ? `slushy://trades/${data[0].coin}` : null;
      case 'webData2': return 'slushy://account';
      case 'userFills': return 'slushy://fills';
      case 'orderUpdates': return 'slushy://orders';
      default: return null;
    }
  }

  /** Subscribe upstream (to HyPaper) for a given resource uri the first time
   *  it's needed. Idempotent. Called on resources/subscribe AND on read. */
  async subscribeUpstream(uri: string): Promise<void> {
    if (this.active.has(uri)) return;
    const sub = this.subForUri(uri);
    if (!sub) return;
    await this.ensureConnected();
    this.active.set(uri, sub);
    this.ws?.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
  }

  private subForUri(uri: string): object | null {
    if (uri === 'slushy://mids') return { type: 'allMids' };
    if (uri === 'slushy://account') return { type: 'webData2', user: this.wallet };
    if (uri === 'slushy://fills') return { type: 'userFills', user: this.wallet };
    if (uri === 'slushy://orders') return { type: 'orderUpdates', user: this.wallet };
    const l2 = uri.match(/^slushy:\/\/l2\/(.+)$/); if (l2) return { type: 'l2Book', coin: l2[1] };
    const tr = uri.match(/^slushy:\/\/trades\/(.+)$/); if (tr) return { type: 'trades', coin: tr[1] };
    return null;
  }

  /** Latest cached frame for a uri (subscribing upstream if needed so a
   *  first read soon has data). */
  async read(uri: string): Promise<unknown> {
    await this.subscribeUpstream(uri);
    return this.latest.get(uri) ?? null;
  }

  close(): void {
    try { this.ws?.close(); } catch { /* */ }
    this.ws = null;
    this.latest.clear();
    this.active.clear();
  }
}

/** Register the streaming resources on a session's server and return the
 *  SessionStreams managing its upstream WS. */
export function attachStreams(server: McpServer, wallet: string): SessionStreams {
  const streams = new SessionStreams(server, wallet);
  const text = (uri: string, data: unknown) => ({
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data ?? null) }],
  });

  // Fixed (non-templated) feeds.
  for (const [name, uri, desc] of [
    ['mids', 'slushy://mids', 'Live mid prices for every coin (allMids).'],
    ['account', 'slushy://account', 'Your live account state: positions + open orders (webData2).'],
    ['fills', 'slushy://fills', 'Your live fills stream.'],
    ['orders', 'slushy://orders', 'Your live order-update stream.'],
  ] as const) {
    server.registerResource(name, uri, { description: desc, mimeType: 'application/json' },
      async () => text(uri, await streams.read(uri)));
  }

  // Per-coin feeds via templates.
  server.registerResource('l2', new ResourceTemplate('slushy://l2/{coin}', { list: undefined }),
    { description: 'Live L2 order book for {coin}.', mimeType: 'application/json' },
    async (uri) => text(uri.href, await streams.read(uri.href)));
  server.registerResource('trades', new ResourceTemplate('slushy://trades/{coin}', { list: undefined }),
    { description: 'Live trades for {coin}.', mimeType: 'application/json' },
    async (uri) => text(uri.href, await streams.read(uri.href)));

  // The high-level McpServer doesn't auto-handle resources/subscribe even with
  // the capability declared, so wire it on the low-level server: a subscribe
  // starts the upstream HyPaper feed (so updates flow without a prior read),
  // and returns an empty result so the handshake succeeds.
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    await streams.subscribeUpstream(req.params.uri).catch(() => {});
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

  return streams;
}
