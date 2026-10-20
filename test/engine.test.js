import test from "node:test";
import assert from "node:assert/strict";
import { analyze, validateRules } from "../src/engine.js";
import { fixture } from "../src/fixtures.js";
import { classifySource, InjectedAdapter } from "../src/adapters.js";
import { APPROVAL_TOPIC, NETWORK, TRANSFER_TOPIC } from "../src/constants.js";
import { addressTopic, dedupeEvents } from "../src/events.js";
import { ensureEvidenceIntegrity, interpretRequest } from "../src/agent.js";
import { persistReport } from "../src/store.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const T = "0xcccccccccccccccccccccccccccccccccccccccc";
const tx = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const log = ({ n = 1, block = 100, topic = TRANSFER_TOPIC, owner = A, peer = B, value = 1n }) => ({ address: T, blockNumber: `0x${block.toString(16)}`, blockTimestamp: "0x68f5d000", transactionHash: tx(n), logIndex: "0x0", data: `0x${value.toString(16).padStart(64, "0")}`, topics: [topic, addressTopic(owner), addressTopic(peer)], removed: false });

test("clean covered fixture is LOW observed risk", () => {
  const result = analyze(fixture("clean"));
  assert.equal(result.riskLevel, "LOW");
  assert.equal(result.coverageStatus, "SUFFICIENT");
  assert.equal(result.signals.length, 4);
});

test("warning fixture reaches HIGH for independent age, flow, and pattern families", () => {
  const result = analyze(fixture("risky"));
  assert.equal(result.riskLevel, "HIGH");
  assert.deepEqual(result.signals.filter((x) => x.status === "FLAG").map((x) => x.id).sort(), ["ACTIVITY_AGE", "COUNTERPARTY_PATTERN", "RAPID_FLOW"]);
});

test("missing or truncated history never becomes LOW", () => {
  const result = analyze(fixture("missing"));
  assert.equal(result.riskLevel, null);
  assert.equal(result.coverageStatus, "INSUFFICIENT_DATA");
  assert.match(result.headline, /unassessed/i);
});

test("stale snapshot becomes insufficient against actual analysis time", () => {
  const snapshot = fixture("clean");
  snapshot.capturedAt = "2020-01-01T00:00:00.000Z";
  const result = analyze(snapshot);
  assert.equal(result.coverage.stale, true);
  assert.equal(result.coverageStatus, "INSUFFICIENT_DATA");
});

test("inbound spam alone does not trigger rapid flow or counterparty pattern", () => {
  const snapshot = fixture("clean");
  snapshot.events = snapshot.events.filter((x) => x.direction === "IN");
  const result = analyze(snapshot);
  assert.equal(result.signals.find((x) => x.id === "RAPID_FLOW").status, "PASS");
  assert.equal(result.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").status, "PASS");
});

test("user watchlist is chain-specific and changes a finding", () => {
  const snapshot = fixture("clean");
  const peer = snapshot.events.find((x) => x.direction === "OUT").to;
  const mismatch = analyze(snapshot, { watchlist: [{ address: peer, chainId: 688689, label: "Review", reason: "User concern", provenance: "user supplied" }] });
  const match = analyze(snapshot, { watchlist: [{ address: peer, chainId: 1672, label: "Review", reason: "User concern", provenance: "user supplied" }] });
  assert.equal(mismatch.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").status, "PASS");
  assert.equal(match.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").status, "FLAG");
  assert.match(match.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").explanation, /USER-FLAGGED/);
});

test("approval event is reconciled with current allowance and deduplicated", async () => {
  const calls = [];
  const approval = log({ topic: APPROVAL_TOPIC, owner: A, peer: B });
  const adapter = new InjectedAdapter(async (name, args) => {
    calls.push({ name, args });
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "100" };
    if (name === "get_code") return { code: "0x" };
    if (name === "eth_call") return { result: `0x${"f".repeat(64)}` };
    if (name === "get_logs" && args.topics[0] === APPROVAL_TOPIC) return [approval, approval];
    if (name === "get_logs") return [];
    throw new Error(name);
  }, () => new Date());
  const snapshot = await adapter.collect(A, { historyBlocks: 100, pageBlocks: 100 });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].allowanceStatus, "VERIFIED");
  assert.equal(analyze(snapshot).signals.find((x) => x.id === "APPROVAL_EXPOSURE").status, "FLAG");
  assert.ok(calls.every((x) => ["get_chain_info", "get_block_number", "get_logs", "eth_call", "get_code"].includes(x.name)));
});

test("historical approval without current allowance is UNKNOWN, not active exposure", async () => {
  const approval = log({ topic: APPROVAL_TOPIC, owner: A, peer: B });
  const adapter = new InjectedAdapter(async (name, args) => {
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "100" };
    if (name === "get_code") return { code: "0x" };
    if (name === "eth_call") throw new Error("non-standard token");
    if (name === "get_logs" && args.topics[0] === APPROVAL_TOPIC) return [approval];
    return [];
  });
  const snapshot = await adapter.collect(A, { historyBlocks: 100, pageBlocks: 100 });
  assert.equal(analyze(snapshot).signals.find((x) => x.id === "APPROVAL_EXPOSURE").status, "UNKNOWN");
});

test("adapter pages exact boundaries and reports complete coverage", async () => {
  const ranges = [];
  const adapter = new InjectedAdapter(async (name, args) => {
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "1100" };
    if (name === "get_code") return { code: "0x" };
    if (name === "get_logs") { ranges.push([args.fromBlock, args.toBlock]); return []; }
    return { result: "0x0" };
  });
  const snapshot = await adapter.collect(A, { historyBlocks: 1100, pageBlocks: 1000 });
  assert.deepEqual([...new Set(ranges.map((x) => x.join("-")))], ["1-1000", "1001-1100"]);
  assert.equal(snapshot.coverage.batches, 6);
  assert.equal(snapshot.coverage.complete, true);
});

test("one failed page is explicit partial coverage, never an empty-history PASS", async () => {
  const adapter = new InjectedAdapter(async (name, args) => {
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "100" };
    if (name === "get_code") return { code: "0x" };
    if (name === "get_logs" && args.topics[0] === APPROVAL_TOPIC) throw new Error("timeout");
    return [];
  });
  const snapshot = await adapter.collect(A, { historyBlocks: 100, pageBlocks: 100 });
  assert.equal(snapshot.coverage.complete, false);
  assert.equal(analyze(snapshot).coverageStatus, "INSUFFICIENT_DATA");
});

test("EOA, verified, unverified, and unknown source states remain distinct", () => {
  assert.equal(classifySource("0x", null).sourceVerification, "NOT_APPLICABLE");
  assert.equal(classifySource("0x6000", { verified: true }).sourceVerification, "VERIFIED");
  assert.equal(classifySource("0x6000", { verified: false }).sourceVerification, "UNVERIFIED");
  assert.equal(classifySource("0x6000", null).sourceVerification, "UNKNOWN");
});

test("first observed age is described as bounded observation, not creation", () => {
  const result = analyze(fixture("risky"));
  const age = result.signals.find((x) => x.id === "ACTIVITY_AGE");
  assert.match(age.explanation, /not a creation date/i);
});

test("threshold validation has exact boundaries", () => {
  assert.equal(validateRules({ historyBlocks: 100 }).historyBlocks, 100);
  assert.equal(validateRules({ historyBlocks: 10000 }).historyBlocks, 10000);
  assert.throws(() => validateRules({ historyBlocks: 99 }));
  assert.throws(() => validateRules({ concentrationPercent: 101 }));
});

test("agent resolves explicit action, handles ambiguity, and declares fallback", () => {
  assert.equal(interpretRequest({ question: "Before I approve this spender, what should I know?" }).action, "approve");
  assert.equal(interpretRequest({ question: "Is this counterparty okay?" }).action, "interact");
  assert.equal(interpretRequest({ action: "send", question: "approve or send?" }).action, "send");
  assert.equal(interpretRequest({}).capability, "DETERMINISTIC_FALLBACK");
});

test("every returned evidence ID resolves to a raw observation", () => {
  const snapshot = fixture("risky");
  assert.doesNotThrow(() => ensureEvidenceIntegrity(analyze(snapshot), snapshot.events));
  const broken = analyze(snapshot);
  broken.signals[0].evidence.push({ id: "missing" });
  assert.throws(() => ensureEvidenceIntegrity(broken, snapshot.events));
});

test("persistence is idempotent and recovered result is historical", async () => {
  const rows = new Map();
  const db = { prepare(sql) { return { values: [], bind(...values) { this.values = values; return this; }, async first() { const payload = rows.get(this.values[0]); return payload ? { payload } : null; }, async run() { rows.set(this.values[1], this.values[7]); return { success: true }; } }; } };
  const snapshot = fixture("clean");
  const report = { id: "one", capturedAt: new Date().toISOString(), snapshot, analysis: analyze(snapshot) };
  assert.equal((await persistReport(db, report, "key")).id, "one");
  const recovered = await persistReport(db, { ...report, id: "two" }, "key");
  assert.equal(recovered.id, "one");
  assert.equal(recovered.historical, true);
});

test("deduplication key is transaction hash plus log index", () => {
  const one = { id: `${tx(1)}:0`, blockNumber: 1, logIndex: 0 };
  const two = { ...one, id: `${tx(1)}:1`, logIndex: 1 };
  assert.equal(dedupeEvents([one, one, two]).length, 2);
});

test("token sender is not called initiator when transaction.from differs", async () => {
  const outbound = log({ owner: A, peer: B, block: 90 });
  const adapter = new InjectedAdapter(async (name, args) => {
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "100" };
    if (name === "get_code") return { code: "0x" };
    if (name === "get_transaction") return { from: B };
    if (name === "get_logs" && args.topics[0] === TRANSFER_TOPIC && args.topics[1] === addressTopic(A)) return [outbound];
    if (name === "get_logs") return [];
    throw new Error(name);
  });
  const snapshot = await adapter.collect(A, { historyBlocks: 100, pageBlocks: 100 });
  assert.equal(snapshot.events[0].initiationStatus, "NOT_INITIATED");
  const result = analyze(snapshot);
  assert.equal(result.signals.find((x) => x.id === "RAPID_FLOW").status, "PASS");
  assert.equal(result.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").observed.initiatedOutflows, 0);
});

test("contract token movement is distinct from transaction initiation", async () => {
  const outbound = log({ owner: A, peer: B, block: 90 });
  const adapter = new InjectedAdapter(async (name, args) => {
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "100" };
    if (name === "get_code") return { code: "0x6000" };
    if (name === "get_transaction") return { from: B };
    if (name === "get_logs" && args.topics[0] === TRANSFER_TOPIC && args.topics[1] === addressTopic(A)) return [outbound];
    return [];
  });
  const snapshot = await adapter.collect(A, { historyBlocks: 100, pageBlocks: 100 });
  assert.equal(snapshot.identity.accountType, "CONTRACT");
  assert.equal(snapshot.events[0].initiationStatus, "CONTRACT_TOKEN_MOVEMENT");
  const result = analyze(snapshot);
  assert.equal(result.signals.find((x) => x.id === "RAPID_FLOW").status, "NOT_APPLICABLE");
  assert.equal(result.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").status, "NOT_APPLICABLE");
});

test("failed code read yields UNKNOWN account type, never EOA", async () => {
  const adapter = new InjectedAdapter(async (name) => {
    if (name === "get_chain_info") return { chainId: 1672 };
    if (name === "get_block_number") return { blockNumber: "100" };
    if (name === "get_code") throw new Error("RPC unavailable");
    if (name === "get_logs") return [];
    return { result: "0x0" };
  });
  const snapshot = await adapter.collect(A, { historyBlocks: 100, pageBlocks: 100 });
  assert.equal(snapshot.identity.accountType, "UNKNOWN");
  assert.equal(snapshot.identity.sourceVerification, "UNKNOWN");
  assert.equal(analyze(snapshot).coverageStatus, "INSUFFICIENT_DATA");
});

test("rapid flow uses exact transaction/log order and each outgoing at most once", () => {
  const snapshot = fixture("clean");
  const event = (id, direction, txIndex, logIndex) => ({ id: `${tx(id)}:${logIndex}`, type: "TRANSFER", contract: T, blockNumber: 5000, transactionIndex: txIndex, logIndex, transactionHash: tx(id), rawValue: "1", direction, from: direction === "OUT" ? snapshot.target : B, to: direction === "OUT" ? B : snapshot.target, initiationStatus: direction === "OUT" ? "VERIFIED" : null });
  snapshot.events = [event(1, "IN", 1, 5), event(2, "OUT", 1, 4)];
  let rapid = analyze(snapshot).signals.find((x) => x.id === "RAPID_FLOW");
  assert.equal(rapid.status, "PASS", "an earlier log in the same transaction must not match");
  snapshot.events = [event(3, "IN", 1, 1), event(4, "IN", 1, 2), event(5, "OUT", 1, 3)];
  rapid = analyze(snapshot).signals.find((x) => x.id === "RAPID_FLOW");
  assert.equal(rapid.observed.sequences, 1, "one outgoing cannot satisfy two sequences");
  assert.match(rapid.explanation, /does not trace the same token units/i);
});

test("watchlist configuration re-evaluates the exact same snapshot", () => {
  const snapshot = fixture("clean");
  const peer = snapshot.events.find((x) => x.direction === "OUT").to;
  const plain = analyze(snapshot);
  const configured = analyze(snapshot, { watchlist: [{ address: peer, chainId: 1672, label: "Review", reason: "User concern", provenance: "user supplied" }] });
  assert.strictEqual(plain.target, configured.target);
  assert.strictEqual(plain.coverage.analysisBlock, configured.coverage.analysisBlock);
  assert.deepEqual(plain.coverage.requested, configured.coverage.requested);
  assert.equal(plain.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").status, "PASS");
  assert.equal(configured.signals.find((x) => x.id === "COUNTERPARTY_PATTERN").status, "FLAG");
});
