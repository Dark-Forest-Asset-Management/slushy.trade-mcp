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
import { buildSession } from './mcp.js';
import { setChart, setDrawings, getAgentDrawings } from './chart-store.js';
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

  const sessions = new Map<string, Session>();

  app.get('/health', (_req, res) => res.json({ status: 'ok', sessions: sessions.size }));

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
    res.json({ drawings: getAgentDrawings(auth.wallet) });
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
      res.status(auth.status).json({ jsonrpc: '2.0', error: { code: -32001, message: auth.error }, id: null });
      return;
    }

    const { server, streams } = buildSession(auth.wallet);
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
