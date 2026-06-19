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
 *   - OpenAI    → our own MCP client (Streamable HTTP) + a manual Responses
 *                 function-call loop. NOT the hosted `mcp` tool: OpenAI's hosted
 *                 connector does not forward IMAGE tool-results to the model, so
 *                 get_chart_image was blind there. Running the client ourselves
 *                 lets us inject the chart as an input_image (like Gemini).
 *   - Gemini    → an MCP client (Streamable HTTP) wrapped by mcpToTool()
 * For Anthropic the provider reaches /mcp server-side; for OpenAI + Gemini we
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

export type TradeMode = 'live' | 'paper';

export interface ChatStreamOpts {
  provider: ChatProvider;
  model: string;
  /** BYO LLM key — used once, never logged or persisted. */
  apiKey: string;
  messages: ChatMessage[];
  /** The user's raw slushy MCP token (no "Bearer" prefix). */
  mcpToken: string;
  /** Whether the user's slushy session is on live Hyperliquid or paper. Drives
   *  the system prompt wording (and, downstream, which account the tools act on). */
  mode: TradeMode;
}

/** Callbacks the route maps onto SSE frames. */
export interface ChatSink {
  text: (t: string) => void;
  tool: (name: string) => void;
  error: (msg: string) => void;
}

// Our own public /mcp. `?mode=live` binds the session to the user's live HL
// account (reads); paper omits it. The connectors POST to this exact URL.
const mcpUrl = (mode: TradeMode) => mode === 'live' ? `${config.mcpResourceUrl}?mode=live` : config.mcpResourceUrl;

function systemPrompt(mode: TradeMode): string {
  if (mode === 'live') {
    return [
      'You are slushy, the in-app trading copilot on slushy.trade, connected to the',
      "user's LIVE Hyperliquid account. You have tools (via the connected slushy MCP",
      "server) to read the user's account, positions and orders, live markets, and their",
      'current chart (get_chart_image / get_chart_drawings), and to place, modify, and',
      'cancel orders. These are REAL orders settling with REAL funds on Hyperliquid.',
      'Be concise and concrete. Quote real numbers from tool results — never invent',
      'prices or balances. ALWAYS restate the exact order (side, size, coin, price) and',
      'get explicit confirmation before placing or cancelling, unless the user already',
      'gave a fully specified instruction.',
    ].join(' ');
  }
  return [
    'You are slushy, the in-app trading copilot on slushy.trade — a Hyperliquid',
    'paper-trading frontend. You have tools (via the connected slushy MCP server)',
    'to read the user\'s account, live markets, and their current chart',
    '(get_chart_image / get_chart_drawings), and to place, modify, and cancel',
    'orders. This is the user\'s own paper-trading account.',
    'Be concise and concrete. Quote real numbers from tool results — never invent',
    'prices or balances. Before placing or cancelling an order, restate what you',
    'are about to do in one line unless the user was already explicit.',
  ].join(' ');
}

// Max output tokens for the Anthropic path (the only provider that requires an
// explicit cap; OpenAI/Gemini use their high provider defaults). Generous for a
// copilot — it's just a ceiling, the model still stops when it's done.
const MAX_TOKENS = 16384;
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
    system: systemPrompt(o.mode),
    messages: o.messages.map((m) => ({ role: m.role, content: m.content })),
    mcp_servers: [{ type: 'url', url: mcpUrl(o.mode), name: 'slushy', authorization_token: o.mcpToken }],
    // Each server in mcp_servers MUST be referenced by an mcp_toolset in tools,
    // or the API 400s: "MCP server 'slushy' is defined but not referenced by
    // any mcp_toolset in tools." mcp_server_name must match the server name above.
    tools: [{ type: 'mcp_toolset', mcp_server_name: 'slushy' }],
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

// ─── OpenAI (own MCP client + manual Responses tool loop, with chart vision) ─
// OpenAI's HOSTED MCP connector doesn't feed IMAGE tool-results to the model as
// vision, so get_chart_image was blind on OpenAI while Gemini (own client)
// could see it. We mirror Gemini: open our own MCP client, drive the
// function-call loop ourselves, and inject any image tool-result as an
// input_image. Conversation context is chained via previous_response_id so we
// never have to replay reasoning items by hand.
async function streamOpenAI(o: ChatStreamOpts, sink: ChatSink): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(o.mode)), {
    requestInit: { headers: { Authorization: `Bearer ${o.mcpToken}` } },
  });
  const mcp = new Client({ name: 'slushy-chat', version: '0.1.0' });
  await mcp.connect(transport);
  try {
    const client = new OpenAI({ apiKey: o.apiKey });
    const listed = await mcp.listTools();
    const tools = listed.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description ?? '',
      parameters: (t.inputSchema as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} },
      strict: false,
    }));

    // First turn carries the chat history; later turns carry only the new tool
    // results (+ any injected images). previous_response_id threads the rest.
    let nextInput: unknown[] = o.messages.map((m) => ({ role: m.role, content: m.content }));
    let prevId: string | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = await client.responses.create({
        model: o.model,
        instructions: systemPrompt(o.mode),
        input: nextInput as never,
        tools,
        stream: true,
        ...(prevId ? { previous_response_id: prevId } : {}),
      });

      let output: Array<Record<string, unknown>> = [];
      for await (const event of stream) {
        const e = event as {
          type: string; delta?: string;
          item?: { type?: string; name?: string };
          response?: { id?: string; output?: Array<Record<string, unknown>> };
        };
        if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') {
          sink.text(e.delta);
        } else if (e.type === 'response.output_item.added' && e.item?.type === 'function_call' && e.item.name) {
          sink.tool(e.item.name);
        } else if (e.type === 'response.completed' && e.response) {
          output = e.response.output ?? [];
          prevId = e.response.id ?? prevId;
        }
      }

      const calls = output.filter((it) => it.type === 'function_call') as Array<{
        name: string; arguments: string; call_id: string;
      }>;
      if (calls.length === 0) return;       // model produced its final answer

      // Each tool result becomes a function_call_output; image content is
      // additionally injected as a vision input (the whole reason we run our
      // own client for OpenAI).
      nextInput = [];
      for (const call of calls) {
        let textOut: string;
        const images: Array<{ data: string; mimeType?: string }> = [];
        try {
          const result = await mcp.callTool({
            name: call.name,
            arguments: call.arguments ? JSON.parse(call.arguments) : {},
          });
          const content = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
          const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text as string);
          for (const c of content) if (c.type === 'image' && c.data) images.push({ data: c.data, mimeType: c.mimeType });
          textOut = texts.join('\n') || (images.length ? '[chart image returned — attached as the next message]' : '(no output)');
        } catch (err) {
          textOut = `Tool error: ${(err as Error).message}`;
        }
        nextInput.push({ type: 'function_call_output', call_id: call.call_id, output: textOut });
        for (const img of images) {
          nextInput.push({
            role: 'user',
            content: [{ type: 'input_image', image_url: `data:${img.mimeType ?? 'image/png'};base64,${img.data}`, detail: 'auto' }],
          });
        }
      }
    }
  } finally {
    await mcp.close();
  }
}

// ─── Gemini (own MCP client + mcpToTool) ───────────────────────────────────
async function streamGemini(o: ChatStreamOpts, sink: ChatSink): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(o.mode)), {
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
        systemInstruction: systemPrompt(o.mode),
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
