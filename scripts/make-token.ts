/**
 * Mint an MCP access token from a wallet private key (for testing / CLI use).
 *
 *   PRIVATE_KEY=0x... npm run token
 *   npm run token 0x<privateKey>
 *
 * Prints the base64url token to stdout. Use it as `Authorization: Bearer <token>`.
 * The wallet must hold an active supporter subscription for the server to
 * accept it. Standalone — does NOT load the server config (no env needed).
 *
 * NOTE: the signed message MUST stay byte-identical to mcpAccessMessage() in
 * src/auth.ts.
 */

import { ethers } from 'ethers';

function mcpAccessMessage(address: string): string {
  return `slushy.trade MCP access\nwallet: ${address.toLowerCase()}`;
}

const pk = process.env.PRIVATE_KEY ?? process.argv[2];
if (!pk) {
  console.error('Usage: PRIVATE_KEY=0x... npm run token   (or: npm run token <privateKey>)');
  process.exit(1);
}

(async () => {
  const wallet = new ethers.Wallet(pk);
  const address = wallet.address;
  const signature = await wallet.signMessage(mcpAccessMessage(address));
  const token = Buffer.from(JSON.stringify({ address, signature }), 'utf8').toString('base64url');

  console.error(`wallet:  ${address}`);
  console.error(`message: ${JSON.stringify(mcpAccessMessage(address))}`);
  console.error('\nAuthorization: Bearer (token below)\n');
  console.log(token);
})().catch((e) => { console.error(e); process.exit(1); });
