/**
 * In-app chat backend — the host for slushy's own chat panel.
 *
 * BYO-key: the user's LLM API key arrives in the request body, is used for
 * exactly one streamed completion, and is NEVER logged or stored. The chat is
 * supporter-gated by the SAME wallet-signature token the MCP server already
 * verifies (see auth.ts) — that token doubles as the MCP credential below.
 *
 * Tools come from THIS server's own /mcp endpoint (config.mcpResourceUrl), so
 * the chat reuses the entire tool surface (account, markets, place_order,
 * get_chart_image, …) with zero re-plumbing:
 *   - Anthropic → Messages API `mcp_servers` connector (beta mcp-client-2025-11-20)
 *   - OpenAI    → Responses API hosted `mcp` tool (authorization = the token)
 *   - Gemini    → an MCP client (Streamable HTTP) wrapped by mcpToTool()
 * For Anthropic/OpenAI the provider reaches /mcp server-side; for Gemini we
 * open the MCP client ourselves. All three pass the user's token, so a chat
 * can only ever touch that wallet's own paper account.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI, mcpToTool } from '@google/genai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';

export type ChatProvider = 'anthropic' | 'openai' | 'gemini';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface ChatStreamOpts {
  provider: ChatProvider;
  model: string;
  /** BYO LLM key — used once, never logged or persisted. */
  apiKey: string;
  messages: ChatMessage[];
  /** The user's raw slushy MCP token (no "Bearer" prefix). */
  mcpToken: string;
}

/** Callbacks the route maps onto SSE frames. */
export interface ChatSink {
  text: (t: string) => void;
  tool: (name: string) => void;
  error: (msg: string) => void;
}

const MCP_URL = config.mcpResourceUrl; // our own public /mcp

const SYSTEM = [
  'You are slushy, the in-app trading copilot on slushy.trade — a Hyperliquid',
  'paper-trading frontend. You have tools (via the connected slushy MCP server)',
  'to read the user\'s paper account, live markets, and their current chart',
  '(get_chart_image / get_chart_drawings), and to place, modify, and cancel',
  'paper orders. Everything is the user\'s own PAPER account.',
  'Be concise and concrete. Quote real numbers from tool results — never invent',
  'prices or balances. Before placing or cancelling an order, restate what you',
  'are about to do in one line unless the user was already explicit.',
].join(' ');

const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 16;

/** Stream a chat completion, relaying text + tool-use to `sink`. */
export async function streamChat(o: ChatStreamOpts, sink: ChatSink): Promise<void> {
  switch (o.provider) {
    case 'anthropic': return streamAnthropic(o, sink);
    case 'openai': return streamOpenAI(o, sink);
    case 'gemini': return streamGemini(o, sink);
    default: sink.error(`Unknown provider: ${String(o.provider)}`);
  }
}

// ─── Anthropic (Messages API MCP connector) ────────────────────────────────
async function streamAnthropic(o: ChatStreamOpts, sink: ChatSink): Promise<void> {
  const client = new Anthropic({ apiKey: o.apiKey });
  const stream = client.beta.messages.stream({
    model: o.model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM,
    messages: o.messages.map((m) => ({ role: m.role, content: m.content })),
    mcp_servers: [{ type: 'url', url: MCP_URL, name: 'slushy', authorization_token: o.mcpToken }],
    betas: ['mcp-client-2025-11-20'],
  });

  stream.on('text', (t) => sink.text(t));
  stream.on('streamEvent', (ev) => {
    // The connector emits an `mcp_tool_use` content block when Claude calls a
    // tool; surface its name for the panel's "running …" indicator.
    if (ev.type === 'content_block_start') {
      const block = ev.content_block as { type?: string; name?: string };
      if (block?.type === 'mcp_tool_use' && block.name) sink.tool(block.name);
    }
  });
  await stream.finalMessage();
}

// ─── OpenAI (Responses API hosted MCP tool) ────────────────────────────────
async function streamOpenAI(o: ChatStreamOpts, sink: ChatSink): Promise<void> {
  const client = new OpenAI({ apiKey: o.apiKey });
  const stream = await client.responses.create({
    model: o.model,
    instructions: SYSTEM,
    input: o.messages.map((m) => ({ role: m.role, content: m.content })),
    tools: [{
      type: 'mcp',
      server_label: 'slushy',
      server_url: MCP_URL,
      authorization: o.mcpToken,
      require_approval: 'never',
    }],
    stream: true,
  });

  for await (const event of stream) {
    const e = event as { type: string; delta?: string; item?: { type?: string; name?: string } };
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') {
      sink.text(e.delta);
    } else if (e.type === 'response.output_item.added' && e.item?.type === 'mcp_call' && e.item.name) {
      sink.tool(e.item.name);
    }
  }
}

// ─── Gemini (own MCP client + mcpToTool) ───────────────────────────────────
async function streamGemini(o: ChatStreamOpts, sink: ChatSink): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${o.mcpToken}` } },
  });
  const mcp = new Client({ name: 'slushy-chat', version: '0.1.0' });
  await mcp.connect(transport);
  try {
    const ai = new GoogleGenAI({ apiKey: o.apiKey });
    const stream = await ai.models.generateContentStream({
      model: o.model,
      contents: o.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: SYSTEM,
        tools: [mcpToTool(mcp)],
        automaticFunctionCalling: { maximumRemoteCalls: MAX_TOOL_ROUNDS },
      },
    });
    for await (const chunk of stream) {
      if (chunk.text) sink.text(chunk.text);
    }
  } finally {
    await mcp.close();
  }
}
