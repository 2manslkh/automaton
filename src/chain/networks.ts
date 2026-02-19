/**
 * Multi-Chain Network Configuration
 *
 * Defines supported networks with their chain IDs, RPC URLs,
 * USDC contract addresses, and ERC-8004 registry addresses.
 * Default selection prefers cheapest L2 for gas efficiency.
 */

import type { Address } from "viem";
import { base, baseSepolia, mainnet, arbitrum, optimism, polygon } from "viem/chains";
import type { Chain } from "viem";

export interface NetworkConfig {
  chainId: number;
  caip2: string; // e.g. "eip155:8453"
  name: string;
  chain: Chain;
  rpcUrl?: string; // override default; undefined = use viem default
  usdcAddress: Address;
  explorerUrl: string;
  erc8004Registry: Address;
  isL2: boolean;
  /** Relative gas cost tier: 1 = cheapest, 5 = most expensive */
  gasCostTier: number;
}

export const SUPPORTED_NETWORKS: Record<string, NetworkConfig> = {
  "eip155:8453": {
    chainId: 8453,
    caip2: "eip155:8453",
    name: "Base",
    chain: base,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorerUrl: "https://basescan.org",
    erc8004Registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    isL2: true,
    gasCostTier: 1,
  },
  "eip155:84532": {
    chainId: 84532,
    caip2: "eip155:84532",
    name: "Base Sepolia",
    chain: baseSepolia,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerUrl: "https://sepolia.basescan.org",
    erc8004Registry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    isL2: true,
    gasCostTier: 1,
  },
  "eip155:1": {
    chainId: 1,
    caip2: "eip155:1",
    name: "Ethereum",
    chain: mainnet,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    explorerUrl: "https://etherscan.io",
    erc8004Registry: "0x0000000000000000000000000000000000000000",
    isL2: false,
    gasCostTier: 5,
  },
  "eip155:42161": {
    chainId: 42161,
    caip2: "eip155:42161",
    name: "Arbitrum",
    chain: arbitrum,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorerUrl: "https://arbiscan.io",
    erc8004Registry: "0x0000000000000000000000000000000000000000",
    isL2: true,
    gasCostTier: 1,
  },
  "eip155:10": {
    chainId: 10,
    caip2: "eip155:10",
    name: "Optimism",
    chain: optimism,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    explorerUrl: "https://optimistic.etherscan.io",
    erc8004Registry: "0x0000000000000000000000000000000000000000",
    isL2: true,
    gasCostTier: 1,
  },
  "eip155:137": {
    chainId: 137,
    caip2: "eip155:137",
    name: "Polygon",
    chain: polygon,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    explorerUrl: "https://polygonscan.com",
    erc8004Registry: "0x0000000000000000000000000000000000000000",
    isL2: true,
    gasCostTier: 1,
  },
};

/** Get network config by CAIP-2 identifier or friendly name */
export function getNetwork(idOrName: string): NetworkConfig | undefined {
  const normalized = idOrName.trim().toLowerCase();
  // Direct CAIP-2 lookup
  if (SUPPORTED_NETWORKS[idOrName]) return SUPPORTED_NETWORKS[idOrName];
  // Friendly name lookup
  for (const net of Object.values(SUPPORTED_NETWORKS)) {
    if (net.name.toLowerCase() === normalized) return net;
  }
  // Common aliases
  const aliases: Record<string, string> = {
    "base": "eip155:8453",
    "base-sepolia": "eip155:84532",
    "ethereum": "eip155:1",
    "eth": "eip155:1",
    "mainnet": "eip155:1",
    "arbitrum": "eip155:42161",
    "arb": "eip155:42161",
    "optimism": "eip155:10",
    "op": "eip155:10",
    "polygon": "eip155:137",
    "matic": "eip155:137",
  };
  const mapped = aliases[normalized];
  return mapped ? SUPPORTED_NETWORKS[mapped] : undefined;
}

/** Get all supported network configs */
export function getAllNetworks(): NetworkConfig[] {
  return Object.values(SUPPORTED_NETWORKS);
}

/** Get mainnet-only networks (excludes testnets) */
export function getMainnetNetworks(): NetworkConfig[] {
  return getAllNetworks().filter(n => n.chainId !== 84532);
}

/**
 * Select the cheapest network from supported networks.
 * Prefers L2s with lowest gas cost tier.
 */
export function selectCheapestNetwork(
  exclude?: string[],
): NetworkConfig {
  const candidates = getMainnetNetworks()
    .filter(n => !exclude?.includes(n.caip2))
    .sort((a, b) => a.gasCostTier - b.gasCostTier);
  return candidates[0] ?? SUPPORTED_NETWORKS["eip155:8453"];
}

/** Default network for new transactions */
export const DEFAULT_NETWORK = SUPPORTED_NETWORKS["eip155:8453"];
