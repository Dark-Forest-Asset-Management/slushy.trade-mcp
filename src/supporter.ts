/**
 * Active Supporter gate.
 *
 * Reads the deployed subscription contract on Arbitrum to decide whether a
 * wallet may use the MCP server. The contract is named `AdFreeSubscription`
 * ON-CHAIN (it predates the "supporter" rename and can't be renamed once
 * deployed); conceptually it IS the Active Supporter Subscription — tiers
 * "Chill Supporter" ($10 / 30d) and "Beast Supporter" ($25 / 90d). We read
 * its `isPaidAdFree(address)` view + `expiresAt` mapping.
 *
 * Status is cached per address (SUPPORTER_CACHE_TTL_SECONDS) so we don't hit
 * the RPC on every MCP request. The on-chain expiry is still the real access
 * window — a cached "active" lapses within the TTL after the subscription
 * expires.
 */

import { ethers } from 'ethers';
import { config } from './config.js';

const ABI = [
  'function isPaidAdFree(address user) view returns (bool)',
  'function expiresAt(address user) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(config.arbitrumRpc);
const contract = new ethers.Contract(config.supporterContract, ABI, provider);

// VerifiedExecutiveAccess on HyperEVM — `verified(addr)` holders also get
// access (the same gate slushy uses for its live-mode toggle).
const VEN_ABI = ['function verified(address user) view returns (bool)'];
const venProvider = new ethers.JsonRpcProvider(config.hyperevmRpc);
const venContract = new ethers.Contract(config.venContract, VEN_ABI, venProvider);
const venCache = new Map<string, { verified: boolean; checkedAt: number }>();

interface CacheEntry { active: boolean; expiresAt: number; checkedAt: number; }
const cache = new Map<string, CacheEntry>();

export interface SupporterStatus { active: boolean; expiresAt: number; }

export async function getSupporterStatus(address: string): Promise<SupporterStatus> {
  const key = address.toLowerCase();

  // Team/test escape hatch.
  if (config.supporterAllowlist.has(key)) return { active: true, expiresAt: 0 };

  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.checkedAt < config.supporterCacheTtlMs) {
    return { active: cached.active, expiresAt: cached.expiresAt };
  }

  const [active, exp] = await Promise.all([
    contract.isPaidAdFree(key) as Promise<boolean>,
    contract.expiresAt(key) as Promise<bigint>,
  ]);
  const status: CacheEntry = { active, expiresAt: Number(exp), checkedAt: now };
  cache.set(key, status);
  return { active: status.active, expiresAt: status.expiresAt };
}

export async function isActiveSupporter(address: string): Promise<boolean> {
  return (await getSupporterStatus(address)).active;
}

/** True iff `address` holds the VerifiedExecutiveAccess flag on HyperEVM. */
export async function isVerifiedExecutive(address: string): Promise<boolean> {
  const key = address.toLowerCase();
  const now = Date.now();
  const cached = venCache.get(key);
  if (cached && now - cached.checkedAt < config.supporterCacheTtlMs) return cached.verified;
  const verified = (await venContract.verified(key)) as boolean;
  venCache.set(key, { verified, checkedAt: now });
  return verified;
}

export interface AccessStatus {
  supporter: SupporterStatus;
  verifiedExecutive: boolean;
  allowed: boolean;
}

/** Combined MCP-access gate: an active supporter OR a verified executive.
 *  Each chain is checked independently so one RPC being down can't block
 *  access granted by the other. Only surfaces an error if access is NOT
 *  granted AND the supporter (Arbitrum) check failed — so the caller can
 *  return 503 (retryable) rather than a false 402. */
export async function getAccessStatus(address: string): Promise<AccessStatus> {
  let supporter: SupporterStatus = { active: false, expiresAt: 0 };
  let supporterErr: unknown;
  try { supporter = await getSupporterStatus(address); } catch (e) { supporterErr = e; }

  let verifiedExecutive = false;
  try { verifiedExecutive = await isVerifiedExecutive(address); } catch { /* fail-closed */ }

  const allowed = supporter.active || verifiedExecutive;
  if (!allowed && supporterErr) throw supporterErr;
  return { supporter, verifiedExecutive, allowed };
}
