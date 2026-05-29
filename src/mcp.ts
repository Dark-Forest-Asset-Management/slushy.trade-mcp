/**
 * Builds a per-session McpServer bound to one authenticated wallet. Every
 * tool/resource closes over `wallet`, so a session can only ever touch its
 * own paper account — there is no wallet parameter on any tool.
 *
 * Tools proxy the HyPaper backend; streaming resources are attached by
 * SessionStreams (streaming.ts).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { hypaper, resolveAsset, getSzDecimals } from './hypaper.js';
import { priceToWire, sizeToWire } from './precision.js';
import { getAccessStatus } from './supporter.js';
import { getChart, getDrawings, addAgentDrawing, clearAgentDrawings, bumpClearUserDrawings } from './chart-store.js';
import { attachStreams, type SessionStreams } from './streaming.js';

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: 'text' as const, text: msg }] });

export function buildSession(wallet: string): { server: McpServer; streams: SessionStreams } {
  const server = new McpServer(
    { name: 'slushy.trade', version: '0.1.0' },
    { capabilities: { tools: {}, resources: { subscribe: true, listChanged: true } } },
  );

  // ── account / info (read) ──────────────────────────────────────────────
  server.registerTool('get_account',
    { description: 'Your paper account: positions, margin summary, account value, withdrawable.' },
    async () => json(await hypaper.info({ type: 'clearinghouseState', user: wallet })));

  server.registerTool('get_open_orders',
    { description: 'Your resting open orders (with trigger/TP-SL detail).' },
    async () => json(await hypaper.info({ type: 'frontendOpenOrders', user: wallet })));

  server.registerTool('get_fills',
    { description: 'Your recent fills.', inputSchema: { startTime: z.number().int().optional().describe('ms epoch; omit for recent') } },
    async ({ startTime }) => json(await hypaper.info(
      startTime !== undefined ? { type: 'userFillsByTime', user: wallet, startTime } : { type: 'userFills', user: wallet })));

  server.registerTool('get_portfolio',
    { description: 'Account-value / PnL history across day/week/month/allTime (+ perp variants).' },
    async () => json(await hypaper.info({ type: 'portfolio', user: wallet })));

  server.registerTool('get_order_history',
    { description: 'Your historical orders (filled / canceled / triggered), most recent first.', inputSchema: { limit: z.number().int().optional().describe('default 200') } },
    async ({ limit }) => json(await hypaper.info({ type: 'historicalOrders', user: wallet, limit: limit ?? 200 })));

  server.registerTool('get_funding_history',
    { description: 'Funding payments applied to your positions.', inputSchema: { startTime: z.number().int().optional() } },
    async ({ startTime }) => json(await hypaper.info({ type: 'userFunding', user: wallet, startTime: startTime ?? 0 })));

  server.registerTool('get_ledger',
    { description: 'Non-funding balance changes (deposits / withdrawals / transfers).', inputSchema: { startTime: z.number().int().optional() } },
    async ({ startTime }) => json(await hypaper.info({ type: 'userNonFundingLedgerUpdates', user: wallet, startTime: startTime ?? 0 })));

  server.registerTool('get_fees',
    { description: 'Your fee schedule + daily volume + maker/taker rates.' },
    async () => json(await hypaper.info({ type: 'userFees', user: wallet })));

  server.registerTool('get_predicted_fundings',
    { description: 'Predicted next funding rates per coin/venue.' },
    async () => json(await hypaper.info({ type: 'predictedFundings' })));

  server.registerTool('get_spot_balances',
    { description: 'Your spot balances (spotClearinghouseState). Note: HyPaper spot support is limited.' },
    async () => json(await hypaper.info({ type: 'spotClearinghouseState', user: wallet })));

  server.registerTool('get_supporter_status',
    { description: 'Your MCP access status: supporter subscription (active + expiry) and/or verified-executive flag.' },
    async () => json(await getAccessStatus(wallet)));

  // ── market data (read, public) ──────────────────────────────────────────
  server.registerTool('get_all_mids',
    { description: 'Mid prices for every coin.' },
    async () => json(await hypaper.info({ type: 'allMids' })));

  server.registerTool('get_l2_book',
    { description: 'L2 order book for a coin.', inputSchema: { coin: z.string().describe('e.g. BTC') } },
    async ({ coin }) => json(await hypaper.info({ type: 'l2Book', coin })));

  server.registerTool('get_candles',
    {
      description: 'OHLCV candles for a coin.',
      inputSchema: {
        coin: z.string(), interval: z.string().describe('1m,5m,15m,1h,4h,1d,…'),
        startTime: z.number().int().describe('ms epoch'), endTime: z.number().int().optional(),
      },
    },
    async ({ coin, interval, startTime, endTime }) => json(await hypaper.info({
      type: 'candleSnapshot', req: { coin, interval, startTime, endTime: endTime ?? Date.now() },
    })));

  server.registerTool('get_meta',
    { description: 'Perp universe metadata (coin names, szDecimals, max leverage).' },
    async () => json(await hypaper.info({ type: 'meta' })));

  server.registerTool('get_asset_contexts',
    { description: 'Per-coin market context for every perp: mark/oracle/mid price, funding rate, open interest, 24h volume, prev-day price (metaAndAssetCtxs). Use for funding-aware decisions.' },
    async () => json(await hypaper.info({ type: 'metaAndAssetCtxs' })));

  server.registerTool('get_order_status',
    { description: 'Status of a specific order by oid (filled / open / canceled / triggered).', inputSchema: { oid: z.number().int() } },
    async ({ oid }) => json(await hypaper.info({ type: 'orderStatus', user: wallet, oid })));

  server.registerTool('get_chart_image',
    { description: 'The latest chart screenshot (with drawings) the user exported from slushy, returned as an image for visual analysis. Errors if none has been uploaded yet.' },
    async () => {
      const c = getChart(wallet);
      if (!c) return { isError: true, content: [{ type: 'text' as const, text: 'No chart image pushed yet — use the brain button in slushy first.' }] };
      return { content: [{ type: 'image' as const, data: c.data.toString('base64'), mimeType: c.mimeType }] };
    });

  server.registerTool('get_chart_drawings',
    { description: 'The chart drawings (trendlines, annotations, etc.) the user pushed from slushy, as JSON. Errors if none pushed yet.' },
    async () => {
      const d = getDrawings(wallet);
      if (!d) return { isError: true, content: [{ type: 'text' as const, text: 'No drawings pushed yet — use the brain button in slushy first.' }] };
      return json(d.data);
    });

  server.registerTool('add_chart_drawing',
    {
      description: "Add an AI-authored drawing to the user's chart (trend-line, horizontal-line, fib-retracement, or text). Stored server-side; the slushy chart polls GET /agent-drawings and renders ONLY the drawings whose `coin` matches the market the user is viewing. anchors are {time: unix SECONDS, price}.",
      inputSchema: {
        coin: z.string().describe('the market this drawing belongs to (e.g. BTC, XRP, xyz:CRWV) — it only renders on that chart'),
        type: z.enum(['trend-line', 'horizontal-line', 'fib-retracement', 'text']),
        anchors: z.array(z.object({ time: z.number(), price: z.number() })).min(1),
        color: z.string().optional().describe('hex, e.g. #22d3ee'),
        label: z.string().optional().describe('text for type=text, or a label'),
      },
    },
    async ({ coin, type, anchors, color, label }) => {
      const c = color ?? '#22d3ee';
      const drawing = {
        // `ai-` id namespace: the slushy chart renders these but EXCLUDES
        // them from the user's saved snapshot (isAutoOverlayId). Stable id so
        // re-polls replace rather than duplicate. `coin` scopes it to one market.
        id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        coin,
        type, anchors,
        style: { lineColor: c, lineWidth: 2, lineDash: [], fillColor: c + '33', fillOpacity: 0.1, showLabels: true, labelFont: '12px sans-serif', labelColor: c },
        options: { visible: true, locked: false, zIndex: 0 },
        ...(label ? { text: label } : {}),
      };
      return json({ ok: true, totalAgentDrawings: addAgentDrawing(wallet, drawing) });
    });

  server.registerTool('clear_chart_drawings',
    {
      description: "Clear AI-authored drawings for this wallet (the agent-drawings buffer the slushy chart renders). Set includeUserDrawings=true to ALSO clear the user's own chart drawings (destructive — only on explicit request).",
      inputSchema: { includeUserDrawings: z.boolean().optional() },
    },
    async ({ includeUserDrawings }) => json({
      ok: true,
      clearedAgentDrawings: clearAgentDrawings(wallet),
      clearedUserDrawings: includeUserDrawings ? (bumpClearUserDrawings(wallet), true) : false,
    }));

  // ── trading (write) ──────────────────────────────────────────────────────
  server.registerTool('place_order',
    {
      description: 'Place a perp order. Limit by default; tif=Ioc for market-like. Pass takeProfitPx and/or stopLossPx to submit a LINKED OCO BRACKET (entry + TP + SL as one normalTpsl group) exactly like the slushy trading panel — HyPaper wires the OCO so the surviving leg auto-cancels when one fills, and cascades on entry cancel. Or pass `trigger` for a standalone stop/TP order.',
      inputSchema: {
        coin: z.string().describe('e.g. BTC'),
        isBuy: z.boolean(),
        size: z.string().describe('base-asset size, decimal string'),
        price: z.string().describe('entry/limit price (for a market entry use tif=Ioc with a crossing price)'),
        tif: z.enum(['Gtc', 'Ioc', 'Alo']).optional().describe('default Gtc'),
        reduceOnly: z.boolean().optional(),
        takeProfitPx: z.string().optional().describe('TP trigger price → adds a reduceOnly OCO take-profit child'),
        stopLossPx: z.string().optional().describe('SL trigger price → adds a reduceOnly OCO stop-loss child'),
        trigger: z.object({
          triggerPx: z.string(), isMarket: z.boolean(), tpsl: z.enum(['tp', 'sl']),
        }).optional().describe('standalone trigger order; ignored when takeProfitPx/stopLossPx are given'),
        leverage: z.number().int().min(1).max(200).optional().describe('set leverage for this coin before placing (avoids defaulting to the account max). cross unless cross=false'),
        cross: z.boolean().optional().describe('margin mode for the leverage set; default true (cross)'),
      },
    },
    async ({ coin, isBuy, size, price, tif, reduceOnly, takeProfitPx, stopLossPx, trigger, leverage, cross }) => {
      const a = await resolveAsset(coin);
      // Snap price + size to the asset's tick/lot grid (HL rejects malformed
      // precision). The agent passes human numbers; we canonicalize them.
      const sd = await getSzDecimals(coin);
      const p = priceToWire(Number(price), sd);
      const s = sizeToWire(Number(size), sd);
      // Set leverage deliberately when asked, so a position isn't opened at
      // the account's default (e.g. 20x) by accident.
      if (leverage) await hypaper.exchange(wallet, { type: 'updateLeverage', asset: a, isCross: cross ?? true, leverage });

      // OCO bracket — mirrors the slushy trading panel: entry first, then
      // opposite-side reduceOnly isMarket TP/SL trigger children, grouping
      // normalTpsl. HyPaper links them so one fill cancels the sibling.
      if (takeProfitPx || stopLossPx) {
        const entry = { a, b: isBuy, p, s, r: reduceOnly ?? false, t: { limit: { tif: tif ?? 'Gtc' } } };
        const orders: object[] = [entry];
        if (takeProfitPx) { const tp = priceToWire(Number(takeProfitPx), sd); orders.push({ a, b: !isBuy, p: tp, s, r: true, t: { trigger: { triggerPx: tp, isMarket: true, tpsl: 'tp' } } }); }
        if (stopLossPx) { const sl = priceToWire(Number(stopLossPx), sd); orders.push({ a, b: !isBuy, p: sl, s, r: true, t: { trigger: { triggerPx: sl, isMarket: true, tpsl: 'sl' } } }); }
        return json(await hypaper.exchange(wallet, { type: 'order', grouping: 'normalTpsl', orders }));
      }

      const t = trigger
        ? { trigger: { triggerPx: priceToWire(Number(trigger.triggerPx), sd), isMarket: trigger.isMarket, tpsl: trigger.tpsl } }
        : { limit: { tif: tif ?? 'Gtc' } };
      const order = { a, b: isBuy, p, s, r: reduceOnly ?? false, t };
      return json(await hypaper.exchange(wallet, { type: 'order', grouping: 'na', orders: [order] }));
    });

  server.registerTool('modify_order',
    {
      description: 'Modify a resting order (atomic cancel-and-replace) by oid — e.g. move a limit or a stop. Provide the full new order params. NOTE: replaces as a single order, so it does NOT preserve an OCO bracket link; to re-set a position bracket use modify_bracket.',
      inputSchema: {
        coin: z.string(), oid: z.number().int(),
        isBuy: z.boolean(), size: z.string(), price: z.string(),
        tif: z.enum(['Gtc', 'Ioc', 'Alo']).optional(),
        reduceOnly: z.boolean().optional(),
        trigger: z.object({ triggerPx: z.string(), isMarket: z.boolean(), tpsl: z.enum(['tp', 'sl']) }).optional(),
      },
    },
    async ({ coin, oid, isBuy, size, price, tif, reduceOnly, trigger }) => {
      const a = await resolveAsset(coin);
      const sd = await getSzDecimals(coin);
      const p = priceToWire(Number(price), sd);
      const s = sizeToWire(Number(size), sd);
      const t = trigger
        ? { trigger: { triggerPx: priceToWire(Number(trigger.triggerPx), sd), isMarket: trigger.isMarket, tpsl: trigger.tpsl } }
        : { limit: { tif: tif ?? 'Gtc' } };
      const order = { a, b: isBuy, p, s, r: reduceOnly ?? false, t };
      void a; // asset resolved for validation/symmetry; modify keys off oid
      return json(await hypaper.exchange(wallet, { type: 'modify', oid, order }));
    });

  server.registerTool('modify_bracket',
    {
      description: "Adjust the TP and/or SL on your OPEN position for `coin` to new prices — modifying the existing trigger legs IN PLACE (single `modify` per leg, exactly like dragging the TP/SL line on the slushy chart). Adds a leg if that side has none. Pass takeProfitPx and/or stopLossPx.",
      inputSchema: {
        coin: z.string(),
        takeProfitPx: z.string().optional(),
        stopLossPx: z.string().optional(),
      },
    },
    async ({ coin, takeProfitPx, stopLossPx }) => {
      if (!takeProfitPx && !stopLossPx) return fail('Provide takeProfitPx and/or stopLossPx.');
      const a = await resolveAsset(coin);
      const sd = await getSzDecimals(coin);

      const state = await hypaper.info({ type: 'clearinghouseState', user: wallet }) as
        { assetPositions: Array<{ position: { coin: string; szi: string } }> };
      const pos = state.assetPositions.find((p) => p.position.coin === coin)?.position;
      if (!pos || Number(pos.szi) === 0) return fail(`No open ${coin} position to bracket.`);
      const size = sizeToWire(Math.abs(Number(pos.szi)), sd);
      const closeIsBuy = Number(pos.szi) < 0; // closing side is opposite the position

      // Existing reduceOnly trigger legs for this coin, classified by HL's
      // orderType string ("Take Profit Market" / "Stop Market").
      const open = await hypaper.info({ type: 'frontendOpenOrders', user: wallet }) as
        Array<{ coin: string; oid: number; isTrigger: boolean; reduceOnly: boolean; orderType: string }>;
      const legs = open.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly);
      const tpLeg = legs.find((o) => /take profit/i.test(o.orderType));
      const slLeg = legs.find((o) => /stop/i.test(o.orderType));

      // Modify the leg IN PLACE if it exists (preserves its place in the
      // bracket — same as the chart's drag/pencil); otherwise add it.
      const setLeg = async (rawPx: string, tpsl: 'tp' | 'sl', existingOid?: number) => {
        const px = priceToWire(Number(rawPx), sd);
        const order = { a, b: closeIsBuy, p: px, s: size, r: true, t: { trigger: { triggerPx: px, isMarket: true, tpsl } } };
        return existingOid !== undefined
          ? hypaper.exchange(wallet, { type: 'modify', oid: existingOid, order })
          : hypaper.exchange(wallet, { type: 'order', grouping: 'na', orders: [order] });
      };

      const result: Record<string, unknown> = {};
      if (takeProfitPx) result.takeProfit = { action: tpLeg ? `modified oid ${tpLeg.oid}` : 'added', resp: await setLeg(takeProfitPx, 'tp', tpLeg?.oid) };
      if (stopLossPx) result.stopLoss = { action: slLeg ? `modified oid ${slLeg.oid}` : 'added', resp: await setLeg(stopLossPx, 'sl', slLeg?.oid) };
      return json(result);
    });

  server.registerTool('cancel_order',
    { description: 'Cancel one resting order by oid.', inputSchema: { coin: z.string(), oid: z.number().int() } },
    async ({ coin, oid }) => {
      const a = await resolveAsset(coin);
      return json(await hypaper.exchange(wallet, { type: 'cancel', cancels: [{ a, o: oid }] }));
    });

  server.registerTool('cancel_by_cloid',
    { description: 'Cancel an order by its client order id (cloid, 0x-prefixed 16-byte hex).', inputSchema: { coin: z.string(), cloid: z.string() } },
    async ({ coin, cloid }) => {
      const asset = await resolveAsset(coin);
      return json(await hypaper.exchange(wallet, { type: 'cancelByCloid', cancels: [{ asset, cloid }] }));
    });

  // ── stubs: wired to the real HL actions, but HyPaper doesn't implement them
  // yet. They pass through and will start working the moment the backend adds
  // the action (no MCP change needed) — until then HyPaper returns
  // "Unsupported action type". Kept registered so the surface is complete.
  server.registerTool('update_isolated_margin',
    {
      description: 'Add/remove isolated margin on a coin. ntli = USD in 6-dp units (1000000 = $1); + adds, − removes. STUB: requires HyPaper updateIsolatedMargin support (in progress) — errors until then.',
      inputSchema: { coin: z.string(), isBuy: z.boolean(), ntli: z.number().int() },
    },
    async ({ coin, isBuy, ntli }) => {
      const asset = await resolveAsset(coin);
      return json(await hypaper.exchange(wallet, { type: 'updateIsolatedMargin', asset, isBuy, ntli }));
    });

  server.registerTool('schedule_cancel',
    {
      description: "Dead-man's switch: cancel all open orders at `time` (unix ms) unless refreshed; omit time to clear. STUB: requires HyPaper scheduleCancel support (in progress) — errors until then.",
      inputSchema: { time: z.number().int().optional() },
    },
    async ({ time }) => json(await hypaper.exchange(wallet, time !== undefined ? { type: 'scheduleCancel', time } : { type: 'scheduleCancel' })));

  server.registerTool('cancel_all_orders',
    { description: 'Cancel all of your resting open orders.' },
    async () => {
      const open = await hypaper.info({ type: 'frontendOpenOrders', user: wallet }) as Array<{ coin: string; oid: number }>;
      if (!Array.isArray(open) || open.length === 0) return json({ cancelled: 0 });
      const cancels = [] as Array<{ a: number; o: number }>;
      for (const o of open) cancels.push({ a: await resolveAsset(o.coin), o: o.oid });
      return json(await hypaper.exchange(wallet, { type: 'cancel', cancels }));
    });

  server.registerTool('set_leverage',
    {
      description: 'Set leverage + margin mode for a coin.',
      inputSchema: { coin: z.string(), leverage: z.number().int().min(1).max(200), cross: z.boolean().optional().describe('default true (cross)') },
    },
    async ({ coin, leverage, cross }) => {
      const asset = await resolveAsset(coin);
      return json(await hypaper.exchange(wallet, { type: 'updateLeverage', asset, isCross: cross ?? true, leverage }));
    });

  server.registerTool('close_position',
    {
      description: 'Market-close your open position for `coin` (reduceOnly IOC across the book). Optionally close part of it with `size`.',
      inputSchema: { coin: z.string(), size: z.string().optional().describe('partial close size; default = full position') },
    },
    async ({ coin, size }) => {
      const a = await resolveAsset(coin);
      const sd = await getSzDecimals(coin);
      const state = await hypaper.info({ type: 'clearinghouseState', user: wallet }) as
        { assetPositions: Array<{ position: { coin: string; szi: string } }> };
      const pos = state.assetPositions.find((p) => p.position.coin === coin)?.position;
      if (!pos || Number(pos.szi) === 0) return fail(`No open ${coin} position to close.`);
      const szi = Number(pos.szi);
      const closeIsBuy = szi < 0;                 // buy to close a short, sell to close a long
      const closeSz = size ? sizeToWire(Number(size), sd) : sizeToWire(Math.abs(szi), sd);

      // Cancel the position's protective bracket first — otherwise the TP/SL
      // triggers linger as dangling reduceOnly orders after we flatten.
      const open = await hypaper.info({ type: 'frontendOpenOrders', user: wallet }) as
        Array<{ coin: string; oid: number; isTrigger: boolean; reduceOnly: boolean }>;
      const triggers = open.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly);
      if (triggers.length) await hypaper.exchange(wallet, { type: 'cancel', cancels: triggers.map((o) => ({ a, o: o.oid })) });

      const mid = Number((await hypaper.info({ type: 'allMids' }))[coin] ?? 0);
      // IOC across the book: cross aggressively in the close direction.
      const px = priceToWire(closeIsBuy ? mid * 1.05 : mid * 0.95, sd);
      const order = { a, b: closeIsBuy, p: px, s: closeSz, r: true, t: { limit: { tif: 'Ioc' } } };
      const close = await hypaper.exchange(wallet, { type: 'order', grouping: 'na', orders: [order] });
      return json({ cancelledBracket: triggers.map((o) => o.oid), close });
    });

  server.registerTool('place_twap',
    {
      description: 'Open a TWAP order on `coin` — sliced over `minutes` (HL min 5). Buys/sells `size` total. reduceOnly to scale out of a position.',
      inputSchema: {
        coin: z.string(), isBuy: z.boolean(), size: z.string(),
        minutes: z.number().int().min(5), reduceOnly: z.boolean().optional(), randomize: z.boolean().optional(),
      },
    },
    async ({ coin, isBuy, size, minutes, reduceOnly, randomize }) => {
      const a = await resolveAsset(coin);
      const s = sizeToWire(Number(size), await getSzDecimals(coin));
      return json(await hypaper.exchange(wallet, { type: 'twapOrder', twap: { a, b: isBuy, s, r: reduceOnly ?? false, m: minutes, t: randomize ?? false } }));
    });

  server.registerTool('cancel_twap',
    { description: 'Cancel a running TWAP by twapId.', inputSchema: { coin: z.string(), twapId: z.number().int() } },
    async ({ coin, twapId }) => {
      const a = await resolveAsset(coin);
      return json(await hypaper.exchange(wallet, { type: 'twapCancel', a, t: twapId }));
    });

  // ── paper-only admin ──────────────────────────────────────────────────────
  server.registerTool('reset_account',
    { description: 'Wipe your paper positions/orders/fills and reset the balance to default.' },
    async () => json(await hypaper.admin({ type: 'resetAccount', user: wallet })));

  server.registerTool('set_balance',
    { description: 'Set your paper account balance (USDC).', inputSchema: { balance: z.number().nonnegative() } },
    async ({ balance }) => json(await hypaper.admin({ type: 'setBalance', user: wallet, balance })));

  const streams = attachStreams(server, wallet);
  return { server, streams };
}

export { fail };
