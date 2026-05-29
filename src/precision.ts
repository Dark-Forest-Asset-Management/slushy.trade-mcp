/**
 * HL order precision. Prices and sizes must conform to the asset's tick / lot
 * rules or HL (and HyPaper, which mirrors HL) rejects the order with "invalid
 * price" / a 422 deserialize error. The agent passes human numbers; we snap
 * them to the asset's grid before building the wire order.
 *
 * `priceToWire` is copied verbatim from slushy's hlSign.ts (proven against HL
 * prod) — do not "improve" it from memory.
 */

/** Round a price to HL's tick rule and emit a clean wire string:
 *  ≤ 5 significant figures AND ≤ (6 − szDecimals) decimals (perps).
 *  Pass the asset's szDecimals from `meta.universe[idx].szDecimals`. */
export function priceToWire(px: number, szDecimals: number): string {
  if (!Number.isFinite(px) || px <= 0) return String(px);
  const decFromSz = Math.max(0, 6 - szDecimals);
  const intDigits = px >= 1 ? Math.floor(Math.log10(px)) + 1 : 0;
  const decFromSig = Math.max(0, 5 - intDigits);
  const maxDec = Math.min(decFromSz, decFromSig);
  const f = Math.pow(10, maxDec);
  const rounded = Math.round(px * f) / f;
  // toFixed(maxDec) → at most maxDec decimals; strip trailing zeros so
  // "1.5050" → "1.505" (HL re-canonicalizes server-side; matching keeps the
  // action hash stable).
  const fixed = rounded.toFixed(maxDec);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** Round a base-asset size to the asset's szDecimals (HL lot rule) and emit a
 *  clean wire string. */
export function sizeToWire(sz: number, szDecimals: number): string {
  if (!Number.isFinite(sz) || sz < 0) return String(sz);
  const fixed = sz.toFixed(Math.max(0, szDecimals));
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
