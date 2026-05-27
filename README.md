# slushy.trade MCP server

A streaming [MCP](https://modelcontextprotocol.io) server that fronts the
slushy.trade paper-trading backend (HyPaper). It lets an AI agent — Claude
Desktop/Code, an in-app chat panel, or any MCP client — query markets, place
and manage trades on a paper account, stream live data, and read/annotate the
user's chart. Access is gated by an **active supporter subscription**: MCP
access is included with the subscription.

```
MCP client (Claude / ChatGPT / Gemini / Cursor …)
      │  Streamable HTTP + Bearer token (wallet signature)
      ▼
slushy.trade-mcp  ──tools/resources──▶  HyPaper backend (/info, /exchange, /ws)
      │  gate: AdFreeSubscription.isPaidAdFree  (Arbitrum)
      │        VerifiedExecutiveAccess.verified (HyperEVM)
```

## Authentication

There is no secret API key and no token store. A client authenticates with a
**self-authenticating token** = `base64url({ address, signature })`, where the
signature is a `personal_sign` by the wallet over:

```
slushy.trade MCP access
wallet: <lowercased address>
```

On every request the server recovers the signer, confirms it matches, and
checks on-chain access: an **active supporter** (`isPaidAdFree`, Arbitrum) **or**
a **verified executive** (`verified`, HyperEVM). Access lasts exactly as long
as the subscription — the same token keeps working and never needs rotating.

Real users never run a CLI: slushy.trade mints the token silently from the
already-unlocked wallet (or offers a "copy MCP token" button). `npm run token`
is a dev convenience.

## Quick start

```bash
npm install
cp .env.example .env      # set SUPPORTER_CONTRACT + point at your HyPaper
npm start                 # Streamable HTTP MCP on http://127.0.0.1:8788/mcp
```

Mint a test token and connect from Claude Code/Desktop:

```bash
PRIVATE_KEY=0x<key> npm run token          # prints the Bearer token
claude mcp add --transport http slushy http://127.0.0.1:8788/mcp \
  --header "Authorization: Bearer <token>"
```

The same `{ url, header }` works with the Anthropic MCP connector, the OpenAI
Responses API MCP tool, and a Gemini MCP client — the server is model-agnostic.

## Tools

**Account & info:** `get_account` · `get_open_orders` · `get_order_history` ·
`get_order_status` · `get_fills` · `get_portfolio` · `get_funding_history` ·
`get_ledger` · `get_fees` · `get_spot_balances` · `get_supporter_status`

**Market data:** `get_all_mids` · `get_l2_book` · `get_candles` · `get_meta` ·
`get_asset_contexts` · `get_predicted_fundings`

**Trading:** `place_order` (limit / market / **OCO bracket** via
`takeProfitPx`+`stopLossPx` / explicit `leverage`) · `modify_order` ·
`modify_bracket` (adjust TP/SL in place) · `close_position` (flattens **and**
cancels the bracket) · `cancel_order` · `cancel_all_orders` · `cancel_by_cloid` ·
`set_leverage` · `place_twap` · `cancel_twap`

**Chart & AI annotation:** `get_chart_image` · `get_chart_drawings` ·
`add_chart_drawing` (market-scoped via `coin`) · `clear_chart_drawings`
(`includeUserDrawings` to also clear the user's own)

**Paper admin:** `reset_account` · `set_balance`

**Stubs (pending HyPaper support):** `update_isolated_margin` ·
`schedule_cancel` — registered and wired to the real HL actions; they error
("Unsupported action type") until the backend adds them, then work unchanged.

## Streaming resources

Subscribe (`resources/subscribe`) for live `resources/updated` pushes,
relayed from HyPaper's WebSocket:

- `slushy://mids` — all mid prices
- `slushy://l2/{coin}` — L2 order book
- `slushy://trades/{coin}` — trades
- `slushy://account` — positions + open orders (webData2)
- `slushy://fills` — your fills
- `slushy://orders` — your order updates

## HTTP endpoints

- `POST /mcp` · `GET /mcp` · `DELETE /mcp` — Streamable HTTP MCP transport
- `POST /chart` — slushy pushes the exported chart PNG (raw `image/png`)
- `POST /drawings` — slushy pushes the chart drawings JSON
- `GET /agent-drawings` — AI-authored drawings for slushy to render
- `GET /health`

All are supporter-gated except `/health`. CORS is enabled for the slushy
frontend.

## Configuration

See `.env.example`. Key vars: `HYPAPER_HTTP_URL` / `HYPAPER_WS_URL`,
`SUPPORTER_CONTRACT` + `ARBITRUM_RPC`, `VEN_CONTRACT` + `HYPEREVM_RPC`,
`SUPPORTER_CACHE_TTL_SECONDS`.

## License

MIT
