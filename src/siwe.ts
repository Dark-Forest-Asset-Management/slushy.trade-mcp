/**
 * EIP-4361 (Sign-In with Ethereum) message for the slushy MCP access
 * token, shared verbatim with the frontend (slushy.trade/src/api/
 * sendChartToMcp.ts) and scripts/make-token.ts. The old token was a
 * signature over a constant string — no domain, nonce, issued-at or
 * expiry, so one captured token was a permanent credential for the
 * wallet (2026-10-13 review, M9). This keeps the server stateless: the
 * verifier rebuilds the message from the token's own fields and checks
 * the signature, domain and expiry.
 *
 * MUST stay byte-identical across the three copies.
 */
export const SIWE_DOMAIN = 'slushy.trade';
export const SIWE_URI = 'https://slushy.trade/mcp';
export const SIWE_STATEMENT = 'Access the slushy.trade MCP server with this wallet.';
export const SIWE_CHAIN_ID = 42161;

export interface SiweFields {
  address: string;
  nonce: string;
  issuedAt: string;        // RFC 3339
  expirationTime: string;  // RFC 3339
}

export function siweMessage(f: SiweFields): string {
  return [
    `${SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    f.address,
    '',
    SIWE_STATEMENT,
    '',
    `URI: ${SIWE_URI}`,
    'Version: 1',
    `Chain ID: ${SIWE_CHAIN_ID}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expirationTime}`,
  ].join('\n');
}
