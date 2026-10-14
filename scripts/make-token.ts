/**
 * Mint an MCP access token from a wallet private key (for testing / CLI use).
 *
 *   PRIVATE_KEY=0x... npm run token            (30-day token)
 *   npm run token 0x<privateKey> [ttlHours]
 *
 * Prints the base64url token to stdout. Use it as `Authorization: Bearer <token>`.
 * The wallet must hold an active supporter subscription for the server to
 * accept it. Standalone — does NOT load the server config (no env needed).
 */

import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { siweMessage } from '../src/siwe.js';

const pk = process.env.PRIVATE_KEY ?? process.argv[2];
const ttlHours = Number(process.argv[3] ?? 24 * 30);
if (!pk) {
  console.error('Usage: PRIVATE_KEY=0x... npm run token   (or: npm run token <privateKey> [ttlHours])');
  process.exit(1);
}

(async () => {
  const wallet = new ethers.Wallet(pk);
  const fields = {
    address: wallet.address,
    nonce: randomBytes(12).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + ttlHours * 3_600_000).toISOString(),
  };
  const signature = await wallet.signMessage(siweMessage(fields));
  const token = Buffer.from(JSON.stringify({ ...fields, signature }), 'utf8').toString('base64url');

  console.error(`wallet:  ${wallet.address}`);
  console.error(`expires: ${fields.expirationTime}`);
  console.error('\nAuthorization: Bearer (token below)\n');
  console.log(token);
})().catch((e) => { console.error(e); process.exit(1); });
