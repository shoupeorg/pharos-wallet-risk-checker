import { APPROVAL_TOPIC, DEFAULT_RULES, MCP_URL, NETWORK, TRANSFER_TOPIC } from "./constants.js";
import { addressTopic, decodeLog, dedupeEvents, normalizeAddress, ranges } from "./events.js";

const ALLOWANCE_SELECTOR = "0xdd62ed3e";
const MAX_TRANSACTION_ATTRIBUTIONS = 60;
const hex32 = (address) => normalizeAddress(address).slice(2).padStart(64, "0");
const parseText = (result, tool) => {
  if (result?.isError) throw new Error(`${tool} failed`);
  const text = result?.content?.find((x) => x.type === "text")?.text;
  if (!text) throw new Error(`${tool} returned no JSON text`);
  return JSON.parse(text);
};

export function classifySource(code, explorerRecord, codeReadStatus = "SUCCESS") {
  if (codeReadStatus !== "SUCCESS") return { accountType: "UNKNOWN", sourceVerification: "UNKNOWN", explanation: "The code read failed, so this run cannot determine whether the target is an EOA or contract." };
  const hasCode = typeof code === "string" && code !== "0x" && code !== "0x0";
  if (!hasCode) return { accountType: "EOA", sourceVerification: "NOT_APPLICABLE", explanation: "EOAs do not have contract source code." };
  if (!explorerRecord) return { accountType: "CONTRACT", sourceVerification: "UNKNOWN", explanation: "The official MCP confirms bytecode, but source verification requires a separate documented explorer response that was unavailable." };
  if (explorerRecord.verified === true) return { accountType: "CONTRACT", sourceVerification: "VERIFIED", explanation: "A separately attributed explorer record reports verified source." };
  if (explorerRecord.verified === false) return { accountType: "CONTRACT", sourceVerification: "UNVERIFIED", explanation: "A separately attributed explorer record explicitly reports unverified source." };
  return { accountType: "CONTRACT", sourceVerification: "UNKNOWN", explanation: "Explorer verification response was inconclusive." };
}

export class InjectedAdapter {
  constructor(call, now = () => new Date()) { this.call = call; this.now = now; }

  async collect(target, ruleInput = {}) {
    const address = normalizeAddress(target);
    const rules = { ...DEFAULT_RULES, ...ruleInput };
    const chain = await this.call("get_chain_info", {});
    if (chain.chainId !== NETWORK.chainId) throw new Error(`Expected chain ${NETWORK.chainId}; received ${chain.chainId}.`);
    const latestRaw = await this.call("get_block_number", {});
    const latest = Number(BigInt(latestRaw.blockNumber));
    const from = Math.max(0, latest - rules.historyBlocks + 1);
    const pages = ranges(from, latest, rules.pageBlocks);
    const topic = addressTopic(address);
    const events = [];
    const failures = [];
    let batches = 0;
    for (const page of pages) {
      const queries = [
        { direction: "OUT", topics: [TRANSFER_TOPIC, topic] },
        { direction: "IN", topics: [TRANSFER_TOPIC, null, topic] },
        { direction: "APPROVAL", topics: [APPROVAL_TOPIC, topic] },
      ];
      for (const query of queries) {
        try {
          const logs = await this.call("get_logs", { topics: query.topics, fromBlock: String(page.from), toBlock: String(page.to) });
          if (!Array.isArray(logs)) throw new Error("non-array response");
          batches += 1;
          for (const log of logs) {
            const decoded = decodeLog(log, query.direction);
            if (decoded) events.push(decoded);
          }
        } catch (error) {
          failures.push({ fromBlock: page.from, toBlock: page.to, query: query.direction, error: error.message });
        }
      }
    }
    const unique = dedupeEvents(events);
    for (const event of unique.filter((x) => x.type === "APPROVAL")) {
      try {
        const result = await this.call("eth_call", { transaction: { to: event.contract, data: `${ALLOWANCE_SELECTOR}${hex32(event.owner)}${hex32(event.spender)}` }, block: String(latest) });
        if (!/^0x[0-9a-f]{64}$/i.test(result.result)) throw new Error("non-standard allowance result");
        event.currentAllowance = BigInt(result.result).toString();
        event.allowanceStatus = "VERIFIED";
      } catch (error) {
        event.allowanceStatus = "UNKNOWN";
        event.allowanceError = error.message;
      }
    }
    let code = null;
    let codeReadStatus = "SUCCESS";
    try {
      code = (await this.call("get_code", { address, block: String(latest) })).code;
      if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code)) throw new Error("invalid get_code result");
    } catch { codeReadStatus = "FAILED"; }
    const identity = classifySource(code, null, codeReadStatus);
    const outflows = unique.filter((x) => x.type === "TRANSFER" && x.direction === "OUT");
    const txCache = new Map();
    for (const event of outflows) {
      if (!txCache.has(event.transactionHash)) {
        if (txCache.size >= MAX_TRANSACTION_ATTRIBUTIONS) {
          txCache.set(event.transactionHash, { status: "UNKNOWN", error: `Attribution cap of ${MAX_TRANSACTION_ATTRIBUTIONS} unique transactions reached` });
        } else try {
          const transaction = await this.call("get_transaction", { hash: event.transactionHash });
          if (!transaction?.from) throw new Error("transaction.from unavailable");
          txCache.set(event.transactionHash, { status: "VERIFIED", from: normalizeAddress(transaction.from) });
        } catch (error) {
          txCache.set(event.transactionHash, { status: "UNKNOWN", error: error.message });
        }
      }
      const attribution = txCache.get(event.transactionHash);
      event.transactionFrom = attribution.from || null;
      if (attribution.status !== "VERIFIED" || identity.accountType === "UNKNOWN") event.initiationStatus = "UNKNOWN";
      else if (identity.accountType === "CONTRACT") event.initiationStatus = "CONTRACT_TOKEN_MOVEMENT";
      else event.initiationStatus = attribution.from === address ? "VERIFIED" : "NOT_INITIATED";
      if (attribution.error) event.attributionError = attribution.error;
    }
    const unknownAttribution = outflows.filter((x) => x.initiationStatus === "UNKNOWN").length;
    return {
      target: address,
      network: NETWORK,
      analysisBlock: latest,
      capturedAt: this.now().toISOString(),
      identity,
      events: unique,
      coverage: {
        requested: { fromBlock: from, toBlock: latest },
        retrieved: failures.length ? null : { fromBlock: from, toBlock: latest },
        complete: failures.length === 0,
        truncated: false,
        sampled: false,
        batches,
        expectedBatches: pages.length * 3,
        failures,
        attribution: { observedTokenOutflows: outflows.length, uniqueTransactions: txCache.size, maxTransactions: MAX_TRANSACTION_ATTRIBUTIONS, unknown: unknownAttribution, complete: unknownAttribution === 0 },
        source: "Official Pharos Chain MCP",
        endpoint: MCP_URL,
        limits: "get_logs pages are at most 1,000 blocks; this app requests three indexed event views per page.",
      },
    };
  }
}

export async function createLiveAdapter() {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const client = new Client({ name: "pharos-wallet-risk-checker", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(60000) }) });
  await client.connect(transport);
  return {
    adapter: new InjectedAdapter(async (name, args) => parseText(await client.callTool({ name, arguments: args }), name)),
    close: async () => { try { await transport.terminateSession(); } catch {} await client.close(); },
  };
}

export async function collectLive(target, rules) {
  const live = await createLiveAdapter();
  try { return await live.adapter.collect(target, rules); } finally { await live.close(); }
}
