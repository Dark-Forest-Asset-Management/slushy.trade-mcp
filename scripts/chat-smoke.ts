/**
 * Smoke-test the in-app chat route (POST /chat) from the CLI — before wiring
 * the UI. Mints (or reuses) a wallet token, POSTs a turn with a BYO LLM key,
 * and prints the streamed text / tool-calls / errors.
 *
 *   # Anthropic (default)
 *   MCP_URL=http://localhost:8788 \
 *   PRIVATE_KEY=0x<testWalletPk> \
 *   PROVIDER=anthropic MODEL=claude-sonnet-4-6 \
 *   LLM_KEY=sk-ant-... \
 *   npm run chat-smoke -- "what is my account balance and positions?"
 *
 *   # OpenAI / Gemini: set PROVIDER + MODEL + LLM_KEY accordingly.
 *   # Already have a token? Pass TOKEN=<base64url> instead of PRIVATE_KEY.
 *
 * The wallet must pass the supporter gate. For local testing, the easiest path
 * is to add the wallet (lowercased) to SUPPORTER_ALLOWLIST in the server .env.
 *
 * NOTE on tool calls: the provider reaches the MCP server at the server's
 * `mcpResourceUrl` (= PUBLIC_BASE_URL + /mcp). With the default PUBLIC_BASE_URL
 * (https://slushy.trade) Anthropic/OpenAI hit PROD /mcp — fine if prod is up
 * and your token is valid there. To keep tool calls fully LOCAL, run the server
 * with PUBLIC_BASE_URL=http://localhost:8788 and use PROVIDER=gemini (the only
 * one whose MCP client runs in-process and can reach localhost; the hosted
 * Anthropic/OpenAI connectors cannot call a localhost URL).
 */

import { ethers } from 'ethers';

function mcpAccessMessage(address: string): string {
  return `slushy.trade MCP access\nwallet: ${address.toLowerCase()}`;
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.5',
  gemini: 'gemini-3.5-flash',
};

async function mintToken(pk: string): Promise<string> {
  const wallet = new ethers.Wallet(pk);
  const signature = await wallet.signMessage(mcpAccessMessage(wallet.address));
  return Buffer.from(JSON.stringify({ address: wallet.address, signature }), 'utf8').toString('base64url');
}

/** Infer the provider from the key prefix (Anthropic sk-ant-, Gemini AIza, else
 *  OpenAI sk-). PROVIDER env overrides. */
function inferProvider(apiKey: string): string | null {
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('AIza')) return 'gemini';
  if (apiKey.startsWith('sk-')) return 'openai';
  return null;
}

(async () => {
  const base = (process.env.MCP_URL ?? 'http://localhost:8788').replace(/\/$/, '');
  const apiKey = process.env.LLM_KEY;
  if (!apiKey) { console.error('Set LLM_KEY=<your provider API key>'); process.exit(1); }

  // Explicit PROVIDER wins; otherwise infer it from the key.
  const provider = (process.env.PROVIDER?.toLowerCase() || inferProvider(apiKey) || '');
  if (!['anthropic', 'openai', 'gemini'].includes(provider)) {
    console.error(`Could not infer provider from the key — set PROVIDER=anthropic | openai | gemini (got "${provider}")`); process.exit(1);
  }
  const model = process.env.MODEL ?? DEFAULT_MODELS[provider];
  const message = process.argv.slice(2).join(' ') || 'What is my account balance and current positions?';
  if (!model) { console.error('Set MODEL=<provider model>'); process.exit(1); }

  let token = process.env.TOKEN;
  if (!token) {
    const pk = process.env.PRIVATE_KEY;
    if (!pk) { console.error('Set PRIVATE_KEY=0x... (to mint) or TOKEN=<base64url>'); process.exit(1); }
    token = await mintToken(pk);
  }

  console.error(`POST ${base}/chat  [${provider} / ${model}]`);
  console.error(`> ${message}\n`);

  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model, apiKey, messages: [{ role: 'user', content: message }] }),
  });

  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try { const j = await res.json() as { error?: string }; if (j?.error) detail = `HTTP ${res.status}: ${j.error}`; } catch { /* keep */ }
    console.error(`\nrequest failed — ${detail}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawError: string | null = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let evt: { type: string; text?: string; name?: string; error?: string };
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.type === 'text' && evt.text) process.stdout.write(evt.text);
      else if (evt.type === 'tool' && evt.name) process.stderr.write(`\n[tool: ${evt.name}]\n`);
      else if (evt.type === 'error') sawError = evt.error ?? 'chat failed';
      else if (evt.type === 'done') process.stderr.write('\n\n[done]\n');
    }
  }

  if (sawError) { console.error(`\n[stream error] ${sawError}`); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
