/**
 * Express + Streamable HTTP MCP transport, gated by the Active Supporter
 * token. Stateful sessions: one McpServer + one HyPaper upstream WS per
 * connection, bound to the authenticated wallet.
 *
 * Flow:
 *   POST /mcp  (no session id, initialize) → authenticate Bearer token →
 *     build a wallet-bound McpServer + transport, store by session id.
 *   POST/GET/DELETE /mcp (with mcp-session-id) → route to that transport.
 *     (GET = SSE stream, DELETE = close.)
 */

import express, { type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { authenticate } from './auth.js';
import * as oauth from './oauth.js';
import { buildSession } from './mcp.js';
import { streamChat, type ChatMessage, type ChatProvider } from './chat.js';
import { setChart, setDrawings, getAgentDrawings, getClearUserSignal, removeAgentDrawing } from './chart-store.js';
import { getPendingLiveOrders, resolveLiveOrder } from './live-orders.js';
import type { SessionStreams } from './streaming.js';
import { config } from './config.js';

interface Session { transport: StreamableHTTPServerTransport; streams: SessionStreams; }

export function createApp() {
  const app = express();

  // CORS — the slushy browser frontend POSTs cross-origin (brain button →
  // /chart + /drawings) and an in-browser MCP client would hit /mcp. No
  // cookies are used (auth is the Bearer token), so reflecting the origin is
  // safe. Expose mcp-session-id so a browser MCP client can read it. Preflight
  // (OPTIONS) is answered here before any body parsing.
  app.use((req: Request, res: Response, next) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  // OAuth token + registration bodies arrive form-encoded or JSON; parse both.
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  const sessions = new Map<string, Session>();

  app.get('/health', (_req, res) => res.json({ status: 'ok', sessions: sessions.size }));

  // ─── OAuth 2.1 — lets the ChatGPT app + one-click Claude Desktop connect ──
  // The access token issued at the end is the SAME wallet-signature token the
  // resource server already verifies; this is just the standard delivery flow.

  // Protected-resource metadata (RFC 9728). Some clients append the resource
  // path segment, so serve both forms.
  const prMeta = (_req: Request, res: Response) => res.json(oauth.protectedResourceMetadata());
  app.get('/.well-known/oauth-protected-resource', prMeta);
  app.get('/.well-known/oauth-protected-resource/mcp', prMeta);

  // Authorization-server metadata (RFC 8414) + the OIDC alias some clients probe.
  const asMeta = (_req: Request, res: Response) => res.json(oauth.authorizationServerMetadata());
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/mcp', asMeta);
  app.get('/.well-known/openid-configuration', asMeta);

  // Dynamic client registration (RFC 7591) — clients self-register, no secret.
  app.post('/oauth/register', (req: Request, res: Response) => {
    const result = oauth.registerClient((req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown });
    if (!result.ok) { res.status(400).json({ error: result.error, error_description: result.error_description }); return; }
    res.status(201).json(result.doc);
  });

  // Authorization endpoint — the browser lands here; we bounce it to the
  // slushy consent page (connect wallet + sign).
  app.get('/oauth/authorize', (req: Request, res: Response) => {
    const r = oauth.startAuthorize(req.query as Record<string, string | undefined>);
    if (r.kind === 'redirect' || r.kind === 'error_redirect') { res.redirect(302, r.url); return; }
    res.status(r.status).type('text/plain').send(r.error);
  });

  // Consent page asks who's requesting access.
  app.get('/oauth/authorize/info', (req: Request, res: Response) => {
    const info = oauth.authorizeInfo(String(req.query.authzId ?? ''));
    if (!info) { res.status(404).json({ error: 'unknown_or_expired' }); return; }
    res.json(info);
  });

  // Consent page posts the signed wallet token; we mint the code and return
  // the URL to bounce the browser back to the requesting client.
  app.post('/oauth/authorize/complete', async (req: Request, res: Response) => {
    const { authzId, token } = (req.body ?? {}) as { authzId?: string; token?: string };
    if (!authzId || !token) { res.status(400).json({ error: 'authzId and token are required' }); return; }
    const r = await oauth.completeAuthorize(authzId, token);
    if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
    res.json({ redirectTo: r.redirectTo });
  });

  // Token endpoint — authorization code (+ PKCE verifier) → access_token.
  app.post('/oauth/token', (req: Request, res: Response) => {
    const r = oauth.exchangeToken((req.body ?? {}) as Record<string, string | undefined>);
    res.header('Cache-Control', 'no-store');
    if (!r.ok) { res.status(r.status).json({ error: r.error, ...(r.error_description ? { error_description: r.error_description } : {}) }); return; }
    res.json(r.token);
  });

  // Chart screenshot upload (supporter-gated). slushy POSTs the exported PNG
  // (raw image body) with the same Bearer token; cached per wallet for the
  // `get_chart_image` MCP tool. Route-level raw parser so it doesn't collide
  // with the global JSON parser.
  app.post('/chart', express.raw({ type: ['image/png', 'image/jpeg'], limit: '8mb' }), async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'Empty image body — POST a raw image/png (or image/jpeg).' });
      return;
    }
    const mimeType = (req.headers['content-type'] ?? 'image/png').split(';')[0].trim();
    setChart(auth.wallet, body, mimeType);
    res.json({ ok: true, bytes: body.length, mimeType });
  });

  // Chart drawings (vector JSON) push — supporter-gated, cached per wallet for
  // the `get_chart_drawings` MCP tool. Uses the global JSON parser.
  app.post('/drawings', async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const body = req.body;
    if (body == null || typeof body !== 'object') {
      res.status(400).json({ error: 'POST a JSON body with the drawings.' });
      return;
    }
    setDrawings(auth.wallet, body);
    res.json({ ok: true });
  });

  // AI-authored drawings (from the add_chart_drawing tool) for the slushy
  // chart to poll + render. Supporter-gated.
  app.get('/agent-drawings', async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    res.json({ drawings: getAgentDrawings(auth.wallet), clearUserSignal: getClearUserSignal(auth.wallet) });
  });

  // Remove ONE agent drawing by id — the user deleted it on their chart, so it
  // must leave the server buffer or the poll resurrects it (and it would also
  // come back on reload). Supporter-gated. `?id=ai-…`.
  app.delete('/agent-drawings', async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const id = String(req.query.id ?? '');
    if (!id) { res.status(400).json({ error: 'id query param required' }); return; }
    res.json({ ok: true, removed: removeAgentDrawing(auth.wallet, id) });
  });

  // Live-order confirm flow (Part B). In live mode the trade tools QUEUE
  // unsigned actions here; the slushy browser polls them, shows a confirm
  // modal, signs + submits to real HL on approve, then resolves the entry.
  app.get('/live-pending', async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    res.json({ pending: getPendingLiveOrders(auth.wallet) });
  });
  app.post('/live-pending/resolve', async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
    const { id } = (req.body ?? {}) as { id?: string };
    if (!id) { res.status(400).json({ error: 'id is required' }); return; }
    res.json({ resolved: resolveLiveOrder(auth.wallet, id) });
  });

  // In-app chat (SSE). Supporter-gated by the same Bearer token, which also
  // doubles as the MCP credential the chosen provider uses to reach /mcp. The
  // BYO LLM key (body.apiKey) is used once and never logged or stored.
  app.post('/chat', async (req: Request, res: Response) => {
    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }

    const body = (req.body ?? {}) as {
      provider?: string; model?: string; apiKey?: string; messages?: unknown; mode?: string;
    };
    const mode = body.mode === 'live' ? 'live' : 'paper';
    const provider = body.provider as ChatProvider;
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'gemini') {
      res.status(400).json({ error: 'provider must be anthropic | openai | gemini' }); return;
    }
    if (!body.model || typeof body.model !== 'string') { res.status(400).json({ error: 'model is required' }); return; }
    if (!body.apiKey || typeof body.apiKey !== 'string') { res.status(400).json({ error: 'apiKey is required (bring your own key)' }); return; }
    const messages: ChatMessage[] = Array.isArray(body.messages)
      ? (body.messages as ChatMessage[]).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
    if (messages.length === 0) { res.status(400).json({ error: 'messages must be a non-empty array' }); return; }

    // Same token the client authenticated with — re-used as the MCP credential
    // the provider presents back to /mcp (no "Bearer" prefix for the connectors).
    const mcpToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
    (res as Response & { flushHeaders?: () => void }).flushHeaders?.();
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      await streamChat(
        { provider, model: body.model, apiKey: body.apiKey, messages, mcpToken, mode },
        {
          text: (t) => send({ type: 'text', text: t }),
          tool: (name) => send({ type: 'tool', name }),
          error: (msg) => send({ type: 'error', error: msg }),
        },
      );
      send({ type: 'done' });
    } catch (e) {
      // Surface the provider/model error to the panel (e.g. bad key, bad model).
      send({ type: 'error', error: (e as Error).message || 'chat failed' });
    } finally {
      res.end();
    }
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;

    // Existing session → route straight through.
    if (sid && sessions.has(sid)) {
      await sessions.get(sid)!.transport.handleRequest(req, res, req.body);
      return;
    }

    // New session must be an initialize request — and must carry a valid,
    // supporter-gated token.
    if (sid || !isInitializeRequest(req.body)) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null });
      return;
    }

    const auth = await authenticate(req.headers.authorization);
    if (!auth.ok) {
      // Point unauthenticated clients at OAuth discovery so the ChatGPT app /
      // Claude Desktop can start the flow (RFC 9728 challenge).
      if (auth.status === 401) {
        res.header('WWW-Authenticate', `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`);
      }
      res.status(auth.status).json({ jsonrpc: '2.0', error: { code: -32001, message: auth.error }, id: null });
      return;
    }

    // `?mode=live` on the /mcp URL binds the session to the user's live HL
    // account for reads (writes stay blocked until client-side signing lands).
    const mode = req.query.mode === 'live' ? 'live' : 'paper';
    const { server, streams } = buildSession(auth.wallet, mode);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, streams }); },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.get(transport.sessionId)?.streams.close();
        sessions.delete(transport.sessionId);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET = SSE notification stream; DELETE = explicit close. Both require a
  // live session id (already authenticated at initialize).
  const sessionRequest = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (!sid || !sessions.has(sid)) { res.status(400).send('Invalid or missing session id'); return; }
    await sessions.get(sid)!.transport.handleRequest(req, res);
  };
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  return { app, sessions };
}
