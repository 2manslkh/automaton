/**
 * Tests for multi-chain support: networks, multicall, bridge, chain selection.
 */

import { describe, it, expect } from "vitest";
import {
  SUPPORTED_NETWORKS,
  getNetwork,
  getAllNetworks,
  getMainnetNetworks,
  selectCheapestNetwork,
  DEFAULT_NETWORK,
} from "../chain/networks.js";

describe("chain/networks", () => {
  it("has all expected networks", () => {
    const ids = Object.keys(SUPPORTED_NETWORKS);
    expect(ids).toContain("eip155:8453");   // Base
    expect(ids).toContain("eip155:1");      // Ethereum
    expect(ids).toContain("eip155:42161");  // Arbitrum
    expect(ids).toContain("eip155:10");     // Optimism
    expect(ids).toContain("eip155:137");    // Polygon
    expect(ids).toContain("eip155:84532");  // Base Sepolia
  });

  it("each network has required fields", () => {
    for (const net of Object.values(SUPPORTED_NETWORKS)) {
      expect(net.chainId).toBeGreaterThan(0);
      expect(net.caip2).toMatch(/^eip155:\d+$/);
      expect(net.name).toBeTruthy();
      expect(net.usdcAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(net.explorerUrl).toMatch(/^https?:\/\//);
      expect(net.chain).toBeDefined();
      expect(typeof net.gasCostTier).toBe("number");
    }
  });

  it("getNetwork resolves by CAIP-2 ID", () => {
    const net = getNetwork("eip155:8453");
    expect(net).toBeDefined();
    expect(net!.name).toBe("Base");
  });

  it("getNetwork resolves by friendly name", () => {
    expect(getNetwork("base")?.chainId).toBe(8453);
    expect(getNetwork("ethereum")?.chainId).toBe(1);
    expect(getNetwork("arb")?.chainId).toBe(42161);
    expect(getNetwork("op")?.chainId).toBe(10);
    expect(getNetwork("polygon")?.chainId).toBe(137);
    expect(getNetwork("matic")?.chainId).toBe(137);
  });

  it("getNetwork returns undefined for unknown", () => {
    expect(getNetwork("solana")).toBeUndefined();
    expect(getNetwork("eip155:999999")).toBeUndefined();
  });

  it("getAllNetworks returns all entries", () => {
    const all = getAllNetworks();
    expect(all.length).toBe(Object.keys(SUPPORTED_NETWORKS).length);
  });

  it("getMainnetNetworks excludes testnets", () => {
    const mainnets = getMainnetNetworks();
    expect(mainnets.every(n => n.chainId !== 84532)).toBe(true);
    expect(mainnets.length).toBe(getAllNetworks().length - 1);
  });

  it("selectCheapestNetwork prefers L2", () => {
    const cheapest = selectCheapestNetwork();
    expect(cheapest.isL2).toBe(true);
    expect(cheapest.gasCostTier).toBe(1);
  });

  it("selectCheapestNetwork respects exclusions", () => {
    const cheapest = selectCheapestNetwork(["eip155:8453", "eip155:42161", "eip155:10", "eip155:137"]);
    // Only Ethereum mainnet left among mainnets
    expect(cheapest.chainId).toBe(1);
  });

  it("DEFAULT_NETWORK is Base", () => {
    expect(DEFAULT_NETWORK.chainId).toBe(8453);
    expect(DEFAULT_NETWORK.name).toBe("Base");
  });
});

describe("chain/multicall types", () => {
  it("checkAllBalances function exists", async () => {
    const { checkAllBalances } = await import("../chain/multicall.js");
    expect(typeof checkAllBalances).toBe("function");
  });

  it("findRichestChain function exists", async () => {
    const { findRichestChain } = await import("../chain/multicall.js");
    expect(typeof findRichestChain).toBe("function");
  });
});

describe("chain/bridge types", () => {
  it("checkBridgeNeeded function exists", async () => {
    const { checkBridgeNeeded } = await import("../chain/bridge.js");
    expect(typeof checkBridgeNeeded).toBe("function");
  });

  it("getBalancesByChain function exists", async () => {
    const { getBalancesByChain } = await import("../chain/bridge.js");
    expect(typeof getBalancesByChain).toBe("function");
  });
});

describe("chain selection logic", () => {
  it("Ethereum has highest gas cost tier", () => {
    const eth = getNetwork("ethereum")!;
    const base = getNetwork("base")!;
    expect(eth.gasCostTier).toBeGreaterThan(base.gasCostTier);
  });

  it("all L2s have gas cost tier 1", () => {
    const l2s = getAllNetworks().filter(n => n.isL2);
    expect(l2s.every(n => n.gasCostTier === 1)).toBe(true);
  });

  it("Ethereum is not L2", () => {
    const eth = getNetwork("eip155:1")!;
    expect(eth.isL2).toBe(false);
  });
});
