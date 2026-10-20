import { NETWORK } from "./constants.js";

const tx = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const ev = (id, blockNumber, direction, from, to, contract = "0xc879c018db60520f4355c26ed1a6d572cdac1815") => ({ id: `${tx(id)}:0`, type: "TRANSFER", contract, blockNumber, transactionIndex: 0, timestamp: new Date(Date.now() - (6000 - blockNumber) * 1000).toISOString(), transactionHash: tx(id), transactionFrom: direction === "OUT" ? from : null, initiationStatus: direction === "OUT" ? "VERIFIED" : null, logIndex: 0, rawValue: "1000000", direction, from, to });
const CLEAN = "0x1111111111111111111111111111111111111111";
const RISKY = "0x2222222222222222222222222222222222222222";
const PEER = "0x3333333333333333333333333333333333333333";
const base = (target, events, complete = true) => ({ target, network: NETWORK, analysisBlock: 6000, capturedAt: new Date().toISOString(), identity: { accountType: "EOA", sourceVerification: "NOT_APPLICABLE" }, events, coverage: { requested: { fromBlock: 1001, toBlock: 6000 }, retrieved: complete ? { fromBlock: 1001, toBlock: 6000 } : null, complete, truncated: !complete, sampled: false, batches: complete ? 15 : 2, expectedBatches: 15, failures: complete ? [] : [{ query: "OUT", error: "SIMULATED outage" }], source: "SIMULATED fixture" } });

export const fixture = (name) => {
  if (name === "clean") return base(CLEAN, [ev(1, 2000, "IN", PEER, CLEAN), ev(2, 3000, "OUT", CLEAN, PEER)]);
  if (name === "risky") return base(RISKY, [ev(3, 5940, "IN", PEER, RISKY), ev(4, 5942, "OUT", RISKY, PEER), ev(5, 5943, "OUT", RISKY, PEER), ev(6, 5944, "OUT", RISKY, PEER)]);
  return base("0x4444444444444444444444444444444444444444", [], false);
};
