/** Shared by the smoke scripts: mint a wallet (SIWE) MCP token. */
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { siweMessage } from '../src/siwe.js';

export async function mintSiweToken(wallet: ethers.Wallet | ethers.HDNodeWallet, ttlMs = 60 * 60 * 1000): Promise<string> {
  const fields = {
    address: wallet.address,
    nonce: randomBytes(12).toString('base64url'),
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + ttlMs).toISOString(),
  };
  const signature = await wallet.signMessage(siweMessage(fields));
  return Buffer.from(JSON.stringify({ ...fields, signature }), 'utf8').toString('base64url');
}
