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
import { hypaper, resolveAsset } from './hypaper.js';
import { getSupporterStatus } from './supporter.js';
import { getChart } from './chart-store.js';
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

  server.registerTool('get_funding_history',
    { description: 'Funding payments applied to your positions.', inputSchema: { startTime: z.number().int().optional() } },
    async ({ startTime }) => json(await hypaper.info({ type: 'userFunding', user: wallet, startTime: startTime ?? 0 })));

  server.registerTool('get_supporter_status',
    { description: 'Your Active Supporter subscription status (active + expiry).' },
    async () => json(await getSupporterStatus(wallet)));

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

  server.registerTool('get_chart_image',
    { description: 'The latest chart screenshot (with drawings) the user exported from slushy, returned as an image for visual analysis. Errors if none has been uploaded yet.' },
    async () => {
      const c = getChart(wallet);
      if (!c) return { isError: true, content: [{ type: 'text' as const, text: 'No chart image uploaded yet — export/send a chart from slushy first.' }] };
      return { content: [{ type: 'image' as const, data: c.data.toString('base64'), mimeType: c.mimeType }] };
    });

  // ── trading (write) ──────────────────────────────────────────────────────
  server.registerTool('place_order',
    {
      description: 'Place a perp order on your paper account. Limit by default; set tif=Ioc for market-like immediate-or-cancel. For TP/SL pass trigger fields.',
      inputSchema: {
        coin: z.string().describe('e.g. BTC'),
        isBuy: z.boolean(),
        size: z.string().describe('base-asset size, decimal string'),
        price: z.string().describe('limit price, decimal string'),
        tif: z.enum(['Gtc', 'Ioc', 'Alo']).optional().describe('default Gtc'),
        reduceOnly: z.boolean().optional(),
        trigger: z.object({
          triggerPx: z.string(), isMarket: z.boolean(), tpsl: z.enum(['tp', 'sl']),
        }).optional().describe('present → trigger (TP/SL) order'),
      },
    },
    async ({ coin, isBuy, size, price, tif, reduceOnly, trigger }) => {
      const a = await resolveAsset(coin);
      const t = trigger ? { trigger } : { limit: { tif: tif ?? 'Gtc' } };
      const order = { a, b: isBuy, p: price, s: size, r: reduceOnly ?? false, t };
      return json(await hypaper.exchange(wallet, { type: 'order', grouping: 'na', orders: [order] }));
    });

  server.registerTool('cancel_order',
    { description: 'Cancel one resting order by oid.', inputSchema: { coin: z.string(), oid: z.number().int() } },
    async ({ coin, oid }) => {
      const a = await resolveAsset(coin);
      return json(await hypaper.exchange(wallet, { type: 'cancel', cancels: [{ a, o: oid }] }));
    });

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
