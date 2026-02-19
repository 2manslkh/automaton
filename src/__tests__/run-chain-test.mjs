/**
 * Standalone test runner for chain tests (avoids vitest process overhead)
 */
import {
  SUPPORTED_NETWORKS,
  getNetwork,
  getAllNetworks,
  getMainnetNetworks,
  selectCheapestNetwork,
  DEFAULT_NETWORK,
} from "../chain/networks.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); failed++; }
  else { console.log(`  PASS: ${msg}`); passed++; }
}

console.log("=== chain/networks ===");

// has all expected networks
const ids = Object.keys(SUPPORTED_NETWORKS);
assert(ids.includes("eip155:8453"), "has Base");
assert(ids.includes("eip155:1"), "has Ethereum");
assert(ids.includes("eip155:42161"), "has Arbitrum");
assert(ids.includes("eip155:10"), "has Optimism");
assert(ids.includes("eip155:137"), "has Polygon");
assert(ids.includes("eip155:84532"), "has Base Sepolia");

// each network has required fields
for (const net of Object.values(SUPPORTED_NETWORKS)) {
  assert(net.chainId > 0, `${net.name} has chainId`);
  assert(/^eip155:\d+$/.test(net.caip2), `${net.name} has valid caip2`);
  assert(net.name, `${net.name} has name`);
  assert(/^0x[0-9a-fA-F]{40}$/.test(net.usdcAddress), `${net.name} has valid USDC address`);
  assert(/^https?:\/\//.test(net.explorerUrl), `${net.name} has explorer URL`);
  assert(net.chain, `${net.name} has chain`);
  assert(typeof net.gasCostTier === "number", `${net.name} has gasCostTier`);
}

// getNetwork by CAIP-2
assert(getNetwork("eip155:8453")?.name === "Base", "getNetwork by CAIP-2");
// getNetwork by friendly name
assert(getNetwork("base")?.chainId === 8453, "getNetwork 'base'");
assert(getNetwork("ethereum")?.chainId === 1, "getNetwork 'ethereum'");
assert(getNetwork("arb")?.chainId === 42161, "getNetwork 'arb'");
assert(getNetwork("op")?.chainId === 10, "getNetwork 'op'");
assert(getNetwork("polygon")?.chainId === 137, "getNetwork 'polygon'");
assert(getNetwork("matic")?.chainId === 137, "getNetwork 'matic'");
// unknown
assert(getNetwork("solana") === undefined, "unknown returns undefined");

// getAllNetworks
assert(getAllNetworks().length === ids.length, "getAllNetworks count");

// getMainnetNetworks excludes testnets
const mainnets = getMainnetNetworks();
assert(mainnets.every(n => n.chainId !== 84532), "no testnets in mainnet list");
assert(mainnets.length === getAllNetworks().length - 1, "mainnet count");

// selectCheapestNetwork
const cheapest = selectCheapestNetwork();
assert(cheapest.isL2 === true, "cheapest is L2");
assert(cheapest.gasCostTier === 1, "cheapest has tier 1");

// selectCheapestNetwork with exclusions
const excl = selectCheapestNetwork(["eip155:8453", "eip155:42161", "eip155:10", "eip155:137"]);
assert(excl.chainId === 1, "with exclusions falls back to Ethereum");

// DEFAULT_NETWORK
assert(DEFAULT_NETWORK.chainId === 8453, "default is Base");

// chain selection logic
const eth = getNetwork("ethereum");
const baseNet = getNetwork("base");
assert(eth.gasCostTier > baseNet.gasCostTier, "ETH costlier than Base");
assert(getAllNetworks().filter(n => n.isL2).every(n => n.gasCostTier === 1), "all L2s tier 1");
assert(getNetwork("eip155:1").isL2 === false, "Ethereum is not L2");

// multicall and bridge module exports
const mc = await import("../chain/multicall.js");
assert(typeof mc.checkAllBalances === "function", "checkAllBalances exists");
assert(typeof mc.findRichestChain === "function", "findRichestChain exists");
const br = await import("../chain/bridge.js");
assert(typeof br.checkBridgeNeeded === "function", "checkBridgeNeeded exists");
assert(typeof br.getBalancesByChain === "function", "getBalancesByChain exists");

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
