import { APPROVAL_TOPIC, TRANSFER_TOPIC } from "./constants.js";

export const normalizeAddress = (value) => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("A valid 20-byte address is required.");
  return value.toLowerCase();
};
export const addressTopic = (address) => `0x${normalizeAddress(address).slice(2).padStart(64, "0")}`;
const topicAddress = (topic) => normalizeAddress(`0x${String(topic).slice(-40)}`);
const quantity = (value) => BigInt(value).toString();
const numeric = (value) => Number(BigInt(value));

export function decodeLog(log, direction) {
  if (!log || log.removed || !Array.isArray(log.topics)) return null;
  const topic0 = String(log.topics[0]).toLowerCase();
  const base = {
    id: `${String(log.transactionHash).toLowerCase()}:${numeric(log.logIndex)}`,
    contract: normalizeAddress(log.address),
    blockNumber: numeric(log.blockNumber),
    timestamp: log.blockTimestamp ? new Date(numeric(log.blockTimestamp) * 1000).toISOString() : null,
    transactionHash: String(log.transactionHash).toLowerCase(),
    logIndex: numeric(log.logIndex),
    rawValue: quantity(log.data || "0x0"),
    direction,
  };
  if (topic0 === TRANSFER_TOPIC && log.topics.length >= 3) return { ...base, type: "TRANSFER", from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]) };
  if (topic0 === APPROVAL_TOPIC && log.topics.length >= 3) return { ...base, type: "APPROVAL", owner: topicAddress(log.topics[1]), spender: topicAddress(log.topics[2]) };
  return null;
}

export function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => event && !seen.has(event.id) && seen.add(event.id)).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

export function ranges(fromBlock, toBlock, pageBlocks = 1000) {
  const rows = [];
  for (let from = fromBlock; from <= toBlock; from += pageBlocks) rows.push({ from, to: Math.min(toBlock, from + pageBlocks - 1) });
  return rows;
}
