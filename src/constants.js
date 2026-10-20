export const NETWORK = { name: "Pharos Pacific Mainnet", chainId: 1672, nativeSymbol: "PROS", explorer: "https://pharosscan.xyz" };
export const MCP_URL = "https://mcp.pharos.xyz/mcp";
export const ENGINE_VERSION = "risk-engine/1.1.0";
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const DEFAULT_RULES = Object.freeze({
  historyBlocks: 5000,
  pageBlocks: 1000,
  recentFirstSeenBlocks: 120,
  matureObservedBlocks: 1200,
  rapidFlowBlocks: 10,
  concentrationPercent: 80,
  concentrationMinOutflows: 3,
  maxAgeSeconds: 900,
});
