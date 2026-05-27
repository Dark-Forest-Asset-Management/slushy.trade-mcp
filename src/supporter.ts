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
