/**
 * Wallet-based auth for the MCP server.
 *
 * Two token kinds, both self-validating (no token store):
 *
 *  1. WALLET token — base64url(JSON{ address, signature, nonce, issuedAt,
 *     expirationTime }): `signature` is a personal_sign by `address` over
 *     the EIP-4361 message siweMessage(fields) (src/siwe.ts). Verified by
 *     rebuilding the message, recovering the signer, and checking
 *     issuedAt/expirationTime. Revocation without a store = expiry; the
 *     app re-mints per request (1 h), OAuth consent mints 30 d.
 *
 *  2. DELEGATE token — base64url(JSON{ d: { wallet, exp, scope }, mac }):
 *     minted by THIS server (HMAC over the payload with MCP_DELEGATE_SECRET)
 *     for one purpose: the credential forwarded to an LLM vendor so its
 *     host can call /mcp during a chat. Short-lived, scope-tagged, and not
 *     the user's own token (2026-10-13 review, M18).
 *
 * Both are then gated on the on-chain Active Supporter status.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ethers } from 'ethers';
import { getAccessStatus } from './supporter.js';
import { config } from './config.js';
import { siweMessage, type SiweFields } from './siwe.js';

export type AuthResult =
  | { ok: true; wallet: string; kind: 'wallet' | 'delegate' }
  | { ok: false; status: number; error: string };

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

interface WalletToken extends SiweFields { signature: string }

function decodeWalletToken(token: string): WalletToken | null {
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    const f = ['address', 'signature', 'nonce', 'issuedAt', 'expirationTime'] as const;
    if (f.every((k) => typeof obj[k] === 'string')) return obj as unknown as WalletToken;
    return null;
  } catch {
    return null;
  }
}

function verifyWalletToken(t: WalletToken): { ok: true; wallet: string } | { ok: false; error: string } {
  const iat = Date.parse(t.issuedAt);
  const exp = Date.parse(t.expirationTime);
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return { ok: false, error: 'Malformed token timestamps' };
  const now = Date.now();
  if (iat > now + MAX_CLOCK_SKEW_MS) return { ok: false, error: 'Token issued in the future' };
  if (exp <= now) return { ok: false, error: 'Token expired — sign in again' };
  if (t.nonce.length < 8) return { ok: false, error: 'Malformed token nonce' };
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(siweMessage(t), t.signature);
  } catch {
    return { ok: false, error: 'Bad signature' };
  }
  if (recovered.toLowerCase() !== t.address.toLowerCase()) return { ok: false, error: 'Signature does not match address' };
  return { ok: true, wallet: recovered.toLowerCase() };
}

// ── Delegate tokens ─────────────────────────────────────────────────
interface DelegatePayload { wallet: string; exp: number; scope: 'chat' }

function mac(payload: string): string {
  return createHmac('sha256', config.delegateSecret).update(payload).digest('base64url');
}

/** Mint a short-lived delegate for `wallet`. Only the chat route calls this. */
export function mintDelegateToken(wallet: string, ttlMs: number): string {
  const d: DelegatePayload = { wallet: wallet.toLowerCase(), exp: Date.now() + ttlMs, scope: 'chat' };
  const payload = JSON.stringify(d);
  return Buffer.from(JSON.stringify({ d: payload, mac: mac(payload) }), 'utf8').toString('base64url');
}

function verifyDelegateToken(token: string): { ok: true; wallet: string } | { ok: false; error: string } | null {
  let obj: { d?: unknown; mac?: unknown };
  try { obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof obj.d !== 'string' || typeof obj.mac !== 'string') return null;   // not a delegate
  const expected = mac(obj.d);
  const a = Buffer.from(obj.mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'Bad delegate token' };
  let d: DelegatePayload;
  try { d = JSON.parse(obj.d); } catch { return { ok: false, error: 'Bad delegate token' }; }
  if (d.scope !== 'chat' || typeof d.wallet !== 'string' || typeof d.exp !== 'number') return { ok: false, error: 'Bad delegate token' };
  if (d.exp <= Date.now()) return { ok: false, error: 'Delegate token expired' };
  return { ok: true, wallet: d.wallet.toLowerCase() };
}

export function randomNonce(): string {
  return randomBytes(12).toString('base64url');
}

/** Validate an `Authorization: Bearer <token>` value. Returns the authed
 *  (lowercased) wallet or a structured error with an HTTP status. */
export async function authenticate(authorization: string | undefined): Promise<AuthResult> {
  if (!authorization) {
    return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token>' };
  }
  const token = authorization.replace(/^Bearer\s+/i, '').trim();

  let recovered: string;
  let kind: 'wallet' | 'delegate';
  const delegate = verifyDelegateToken(token);
  if (delegate) {
    if (!delegate.ok) return { ok: false, status: 401, error: delegate.error };
    recovered = delegate.wallet; kind = 'delegate';
  } else {
    const decoded = decodeWalletToken(token);
    if (!decoded) return { ok: false, status: 401, error: 'Malformed token — mint a new one from slushy.trade' };
    const v = verifyWalletToken(decoded);
    if (!v.ok) return { ok: false, status: 401, error: v.error };
    recovered = v.wallet; kind = 'wallet';
  }

  let allowed: boolean;
  try {
    allowed = (await getAccessStatus(recovered)).allowed;
  } catch (err) {
    return { ok: false, status: 503, error: `Access check failed: ${(err as Error).message}` };
  }
  if (!allowed) {
    return {
      ok: false,
      status: 402,
      error: 'No active supporter subscription for this wallet. Subscribe at slushy.trade to unlock MCP access.',
    };
  }
  return { ok: true, wallet: recovered, kind };
}
