/**
 * Wallet-based auth for the MCP server.
 *
 * The "token" a client presents is self-authenticating — no server secret,
 * no token store. It is base64url(JSON{ address, signature }), where
 * `signature` is a personal_sign by `address` over MCP_ACCESS_MESSAGE(address).
 * The server recovers the signer, confirms it matches the claimed address,
 * then checks the on-chain Active Supporter status. Access lasts exactly as
 * long as the subscription — the token never needs rotating.
 *
 * Mint a token with `npm run token` (scripts/make-token.ts).
 */

import { ethers } from 'ethers';
import { getAccessStatus } from './supporter.js';

/** The exact message a wallet signs to mint an MCP access token. */
export function mcpAccessMessage(address: string): string {
  return `slushy.trade MCP access\nwallet: ${address.toLowerCase()}`;
}

export type AuthResult =
  | { ok: true; wallet: string }
  | { ok: false; status: number; error: string };

function decodeToken(token: string): { address: string; signature: string } | null {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const obj = JSON.parse(json) as { address?: unknown; signature?: unknown };
    if (typeof obj.address === 'string' && typeof obj.signature === 'string') {
      return { address: obj.address, signature: obj.signature };
    }
    return null;
  } catch {
    return null;
  }
}

/** Validate an `Authorization: Bearer <token>` value. Returns the authed
 *  (lowercased) wallet or a structured error with an HTTP status. */
export async function authenticate(authorization: string | undefined): Promise<AuthResult> {
  if (!authorization) {
    return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token>' };
  }
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const decoded = decodeToken(token);
  if (!decoded) return { ok: false, status: 401, error: 'Malformed token' };

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(mcpAccessMessage(decoded.address), decoded.signature);
  } catch {
    return { ok: false, status: 401, error: 'Bad signature' };
  }
  if (recovered.toLowerCase() !== decoded.address.toLowerCase()) {
    return { ok: false, status: 401, error: 'Signature does not match address' };
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
      error: 'No active supporter subscription or verified-executive access for this wallet. Subscribe at slushy.trade to unlock MCP access.',
    };
  }
  return { ok: true, wallet: recovered.toLowerCase() };
}
