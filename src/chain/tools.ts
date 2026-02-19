/**
 * Multi-Chain Tools
 *
 * Tools for checking balances across chains, setting preferred chain, and chain info.
 */

import type { AutomatonTool, ToolContext } from "../types.js";
import { checkAllBalances } from "./multicall.js";
import { getAllNetworks, getNetwork, selectCheapestNetwork, type NetworkConfig } from "./networks.js";
import { checkBridgeNeeded } from "./bridge.js";
import { getWalletAddress, setPreferredChain, getPreferredChain, recordChainUsed } from "../identity/wallet.js";
import type { Address } from "viem";

export function createChainTools(): AutomatonTool[] {
  return [
    {
      name: "check_all_balances",
      description: "Show USDC balance across all supported chains. Returns per-chain balances and total.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          include_testnets: {
            type: "boolean",
            description: "Include testnet chains (default: false)",
          },
        },
      },
      execute: async (args: Record<string, unknown>, context: ToolContext): Promise<string> => {
        const address = context.identity.address;
        const includeTestnets = args.include_testnets === true;
        const result = await checkAllBalances(address, includeTestnets);
        const preferred = getPreferredChain();

        const lines = result.balances.map(b => {
          const marker = b.network === preferred ? " ★" : "";
          return b.ok
            ? `  ${b.chainName}: ${b.balance.toFixed(2)} USDC${marker}`
            : `  ${b.chainName}: error - ${b.error}`;
        });

        return [
          `USDC Balances (${new Date(result.timestamp).toLocaleString()}):`,
          ...lines,
          ``,
          `Total: ${result.totalBalance.toFixed(2)} USDC`,
          `Preferred chain: ${getNetwork(preferred)?.name ?? preferred}`,
        ].join("\n");
      },
    },
    {
      name: "set_preferred_chain",
      description: "Set the default chain for transactions. Accepts chain name or CAIP-2 ID.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Chain name (e.g. 'base', 'arbitrum', 'optimism') or CAIP-2 ID (e.g. 'eip155:42161')",
          },
        },
        required: ["chain"],
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const chainArg = String(args.chain ?? "");
        const network = getNetwork(chainArg);
        if (!network) {
          const names = getAllNetworks().map(n => n.name).join(", ");
          return `Unknown chain: ${chainArg}. Supported: ${names}`;
        }
        setPreferredChain(network.caip2);
        recordChainUsed(network.caip2);
        return `Preferred chain set to ${network.name} (${network.caip2}).`;
      },
    },
    {
      name: "chain_info",
      description: "Show supported chains and their configurations.",
      category: "financial",
      parameters: {
        type: "object",
        properties: {
          chain: {
            type: "string",
            description: "Optional: specific chain to get details for",
          },
        },
      },
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const chainArg = args.chain ? String(args.chain) : undefined;

        if (chainArg) {
          const net = getNetwork(chainArg);
          if (!net) return `Unknown chain: ${chainArg}`;
          return formatNetworkDetail(net);
        }

        const networks = getAllNetworks();
        const cheapest = selectCheapestNetwork();
        const preferred = getPreferredChain();

        const lines = networks.map(n => {
          const tags: string[] = [];
          if (n.caip2 === preferred) tags.push("preferred");
          if (n.caip2 === cheapest.caip2) tags.push("cheapest");
          if (n.isL2) tags.push("L2");
          const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
          return `  ${n.name} (${n.caip2})${tagStr}`;
        });

        return [`Supported chains:`, ...lines].join("\n");
      },
    },
  ];
}

function formatNetworkDetail(net: NetworkConfig): string {
  return [
    `${net.name}:`,
    `  Chain ID: ${net.chainId}`,
    `  CAIP-2: ${net.caip2}`,
    `  USDC: ${net.usdcAddress}`,
    `  Explorer: ${net.explorerUrl}`,
    `  ERC-8004 Registry: ${net.erc8004Registry}`,
    `  Type: ${net.isL2 ? "L2" : "L1"}`,
    `  Gas Cost Tier: ${net.gasCostTier}/5`,
  ].join("\n");
}
