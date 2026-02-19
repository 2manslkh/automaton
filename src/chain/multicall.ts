/**
 * Multi-Chain Balance Checker
 *
 * Check USDC balances across all supported chains in parallel.
 */

import { createPublicClient, http, type Address } from "viem";
import { getAllNetworks, getMainnetNetworks, type NetworkConfig } from "./networks.js";

const BALANCE_OF_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface ChainBalance {
  network: string;
  chainName: string;
  balance: number;
  ok: boolean;
  error?: string;
}

export interface MultiChainBalanceResult {
  balances: ChainBalance[];
  totalBalance: number;
  timestamp: string;
}

/**
 * Check USDC balance on a single chain.
 */
async function checkBalance(
  address: Address,
  network: NetworkConfig,
): Promise<ChainBalance> {
  try {
    const client = createPublicClient({
      chain: network.chain,
      transport: http(network.rpcUrl),
    });

    const balance = await client.readContract({
      address: network.usdcAddress,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    });

    return {
      network: network.caip2,
      chainName: network.name,
      balance: Number(balance) / 1_000_000,
      ok: true,
    };
  } catch (err: any) {
    return {
      network: network.caip2,
      chainName: network.name,
      balance: 0,
      ok: false,
      error: err?.message || String(err),
    };
  }
}

/**
 * Check USDC balances across all mainnet chains in parallel.
 */
export async function checkAllBalances(
  address: Address,
  includeTestnets = false,
): Promise<MultiChainBalanceResult> {
  const networks = includeTestnets ? getAllNetworks() : getMainnetNetworks();
  const results = await Promise.allSettled(
    networks.map(net => checkBalance(address, net)),
  );

  const balances: ChainBalance[] = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          network: networks[i].caip2,
          chainName: networks[i].name,
          balance: 0,
          ok: false,
          error: r.reason?.message || "Unknown error",
        },
  );

  const totalBalance = balances.reduce(
    (sum, b) => sum + (b.ok ? b.balance : 0),
    0,
  );

  return {
    balances,
    totalBalance,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Find which chain has the highest USDC balance.
 */
export async function findRichestChain(
  address: Address,
): Promise<ChainBalance | null> {
  const result = await checkAllBalances(address);
  const sorted = result.balances
    .filter(b => b.ok && b.balance > 0)
    .sort((a, b) => b.balance - a.balance);
  return sorted[0] ?? null;
}
