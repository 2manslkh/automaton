/**
 * Bridge Awareness
 *
 * Detects when funds are on the wrong chain and suggests bridge actions.
 * Does NOT auto-bridge — only recommends.
 */

import type { Address } from "viem";
import { checkAllBalances, type ChainBalance, type MultiChainBalanceResult } from "./multicall.js";
import { getNetwork, type NetworkConfig } from "./networks.js";

export interface BridgeRecommendation {
  needed: boolean;
  reason: string;
  fromChain: string;
  toChain: string;
  amount: number;
  suggestedBridge: string;
  bridgeUrl: string;
}

/** Known bridge services per chain pair */
const BRIDGE_SERVICES: Record<string, { name: string; url: string }> = {
  default: { name: "Socket (Bungee)", url: "https://bungee.exchange" },
  "eip155:1->eip155:8453": { name: "Base Bridge", url: "https://bridge.base.org" },
  "eip155:1->eip155:42161": { name: "Arbitrum Bridge", url: "https://bridge.arbitrum.io" },
  "eip155:1->eip155:10": { name: "Optimism Bridge", url: "https://app.optimism.io/bridge" },
  "eip155:1->eip155:137": { name: "Polygon Bridge", url: "https://portal.polygon.technology/bridge" },
};

function getBridgeService(from: string, to: string): { name: string; url: string } {
  return BRIDGE_SERVICES[`${from}->${to}`] ?? BRIDGE_SERVICES.default;
}

/**
 * Check if funds need bridging for a payment on a specific chain.
 */
export async function checkBridgeNeeded(
  address: Address,
  targetChain: string,
  requiredAmount: number,
): Promise<BridgeRecommendation | null> {
  const result = await checkAllBalances(address);
  const targetBalance = result.balances.find(b => b.network === targetChain);

  // If target chain has enough funds, no bridge needed
  if (targetBalance && targetBalance.ok && targetBalance.balance >= requiredAmount) {
    return null;
  }

  // Find the chain with the most funds
  const richest = result.balances
    .filter(b => b.ok && b.balance > 0 && b.network !== targetChain)
    .sort((a, b) => b.balance - a.balance)[0];

  if (!richest || richest.balance < requiredAmount) {
    return {
      needed: true,
      reason: `Insufficient USDC across all chains. Need ${requiredAmount} USDC but total available is ${result.totalBalance} USDC.`,
      fromChain: "none",
      toChain: targetChain,
      amount: requiredAmount,
      suggestedBridge: "N/A",
      bridgeUrl: "",
    };
  }

  const bridge = getBridgeService(richest.network, targetChain);
  const targetNet = getNetwork(targetChain);
  const sourceNet = getNetwork(richest.network);

  return {
    needed: true,
    reason: `Need ${requiredAmount} USDC on ${targetNet?.name ?? targetChain} but funds are on ${sourceNet?.name ?? richest.network} (${richest.balance.toFixed(2)} USDC).`,
    fromChain: richest.network,
    toChain: targetChain,
    amount: requiredAmount - (targetBalance?.balance ?? 0),
    suggestedBridge: bridge.name,
    bridgeUrl: bridge.url,
  };
}

/**
 * Get a summary of balances per chain for tracking.
 */
export async function getBalancesByChain(
  address: Address,
): Promise<Map<string, number>> {
  const result = await checkAllBalances(address);
  const map = new Map<string, number>();
  for (const b of result.balances) {
    if (b.ok) map.set(b.network, b.balance);
  }
  return map;
}
