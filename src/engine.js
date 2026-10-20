import { DEFAULT_RULES, ENGINE_VERSION, NETWORK } from "./constants.js";
import { normalizeAddress } from "./events.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const statusRank = { FLAG: 0, UNKNOWN: 1, PASS: 2, NOT_APPLICABLE: 3 };
const source = (id, observation, note) => ({ id, ...observation, note });

export function validateRules(input = {}) {
  const rules = { ...DEFAULT_RULES, ...input };
  for (const key of Object.keys(DEFAULT_RULES)) {
    if (!Number.isInteger(rules[key]) || rules[key] < 0) throw new Error(`Rule ${key} must be a non-negative integer.`);
  }
  if (rules.historyBlocks < 100 || rules.historyBlocks > 10000) throw new Error("historyBlocks must be from 100 to 10000.");
  if (rules.pageBlocks < 1 || rules.pageBlocks > 1000) throw new Error("pageBlocks must be from 1 to 1000.");
  if (rules.concentrationPercent > 100) throw new Error("concentrationPercent cannot exceed 100.");
  return rules;
}

function ageSignal(snapshot, rules) {
  const events = snapshot.events.filter((x) => x.type === "TRANSFER" || x.type === "APPROVAL");
  if (!snapshot.coverage.complete) return signal("ACTIVITY_AGE", "Observed activity maturity", "UNKNOWN", null, `At least ${rules.matureObservedBlocks} observed blocks`, "History retrieval was incomplete, so activity maturity cannot be assessed.", [], "send, approve, interact");
  if (!events.length) return signal("ACTIVITY_AGE", "Observed activity maturity", "UNKNOWN", null, `At least ${rules.matureObservedBlocks} observed blocks`, "No supported token activity was found in the bounded window. This is not proof that the address is new or inactive.", [], "send, approve, interact");
  const earliest = events[0];
  const observedAge = snapshot.analysisBlock - earliest.blockNumber;
  const status = observedAge <= rules.recentFirstSeenBlocks ? "FLAG" : observedAge >= rules.matureObservedBlocks ? "PASS" : "UNKNOWN";
  const explanation = status === "FLAG" ? `The first supported event visible in this window is only ${observedAge} blocks old. That is a limited-history warning, not a creation date or accusation.` : status === "PASS" ? `Supported activity spans at least ${observedAge} blocks in the checked window.` : `Only ${observedAge} blocks of activity are visible; that is not enough to classify maturity.`;
  return signal("ACTIVITY_AGE", "Observed activity maturity", status, { earliestBlock: earliest.blockNumber, observedAgeBlocks: observedAge }, `FLAG at ≤ ${rules.recentFirstSeenBlocks}; PASS at ≥ ${rules.matureObservedBlocks} blocks`, explanation, [source(earliest.id, earliest, "Earliest supported event observed in the checked range")], "send, approve, interact");
}

function approvalSignal(snapshot) {
  if (!snapshot.coverage.complete) return signal("APPROVAL_EXPOSURE", "Current approval exposure", "UNKNOWN", null, "FLAG when a discovered allowance remains effectively unlimited", "Approval history was incomplete, so absence of an event cannot be treated as absence of permission.", [], "approve");
  const approvals = snapshot.events.filter((x) => x.type === "APPROVAL");
  if (!approvals.length) return signal("APPROVAL_EXPOSURE", "Current approval exposure", "PASS", { approvalsObserved: 0 }, "FLAG when a discovered allowance remains effectively unlimited", "No standard Approval events owned by this address were observed in the checked range. Non-standard tokens and older approvals remain outside coverage.", [], "approve");
  const active = approvals.filter((x) => x.allowanceStatus === "VERIFIED" && BigInt(x.currentAllowance) >= MAX_UINT256 / 2n);
  const unknown = approvals.filter((x) => x.allowanceStatus !== "VERIFIED");
  if (active.length) return signal("APPROVAL_EXPOSURE", "Current approval exposure", "FLAG", { approvalsObserved: approvals.length, activeUnlimited: active.length }, "FLAG when a discovered allowance remains effectively unlimited", "At least one spender discovered in real history still has a very large current allowance. This is permission exposure, not proof of misuse.", active.map((x) => source(x.id, x, "Approval event plus current allowance() read")), "approve");
  if (unknown.length) return signal("APPROVAL_EXPOSURE", "Current approval exposure", "UNKNOWN", { approvalsObserved: approvals.length, unresolved: unknown.length }, "FLAG when a discovered allowance remains effectively unlimited", "Approval events were found, but one or more current allowance reads failed or were non-standard. Historical approvals alone do not prove current exposure.", unknown.map((x) => source(x.id, x, "Historical approval; current allowance unresolved")), "approve");
  return signal("APPROVAL_EXPOSURE", "Current approval exposure", "PASS", { approvalsObserved: approvals.length, activeUnlimited: 0 }, "FLAG when a discovered allowance remains effectively unlimited", "Discovered standard approvals were reconciled and none remains effectively unlimited at the analysis block.", approvals.map((x) => source(x.id, x, "Approval event plus current allowance() read")), "approve");
}

function rapidSignal(snapshot, rules) {
  if (!snapshot.coverage.complete) return signal("RAPID_FLOW", "Rapid funding-to-outflow", "UNKNOWN", null, `Inbound then initiated outflow within ${rules.rapidFlowBlocks} blocks`, "Incomplete history prevents a reliable sequence check.", [], "send, interact");
  const incoming = snapshot.events.filter((x) => x.type === "TRANSFER" && x.direction === "IN");
  const outgoing = snapshot.events.filter((x) => x.type === "TRANSFER" && x.direction === "OUT");
  const matches = [];
  for (const received of incoming) {
    const sent = outgoing.find((x) => x.contract === received.contract && x.blockNumber >= received.blockNumber && x.blockNumber - received.blockNumber <= rules.rapidFlowBlocks);
    if (sent) matches.push({ received, sent, gapBlocks: sent.blockNumber - received.blockNumber });
  }
  const status = matches.length ? "FLAG" : "PASS";
  return signal("RAPID_FLOW", "Rapid funding-to-outflow", status, { sequences: matches.length }, `Inbound then initiated outflow within ${rules.rapidFlowBlocks} blocks`, matches.length ? "The address initiated an outgoing transfer soon after receiving the same token. This can be normal routing behavior and is not proof of fraud." : "No matching rapid receive-then-send sequence was observed in the checked range. Unsolicited inbound transfers alone do not trigger this flag.", matches.flatMap((x) => [source(x.received.id, x.received, "Inbound leg"), source(x.sent.id, x.sent, `Initiated outflow ${x.gapBlocks} blocks later`)]), "send, interact");
}

function counterpartySignal(snapshot, rules, watchlist) {
  if (!snapshot.coverage.complete) return signal("COUNTERPARTY_PATTERN", "Counterparty pattern", "UNKNOWN", null, "User watchlist match or concentrated initiated outflows", "Incomplete history prevents counterparty-pattern evaluation.", [], "send, approve, interact");
  const target = snapshot.target;
  const outgoing = snapshot.events.filter((x) => x.type === "TRANSFER" && x.direction === "OUT" && x.from === target);
  const counts = new Map();
  for (const event of outgoing) counts.set(event.to, (counts.get(event.to) || 0) + 1);
  const [topAddress, topCount = 0] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  const percent = outgoing.length ? Math.floor((topCount * 100) / outgoing.length) : 0;
  const listed = watchlist.filter((entry) => entry.chainId === NETWORK.chainId).map((entry) => ({ ...entry, address: normalizeAddress(entry.address) }));
  const matches = outgoing.filter((event) => listed.some((entry) => entry.address === event.to));
  const concentrated = outgoing.length >= rules.concentrationMinOutflows && percent >= rules.concentrationPercent;
  const status = matches.length || concentrated ? "FLAG" : "PASS";
  const reasons = [];
  if (matches.length) reasons.push(`${matches.length} initiated transfer(s) reached a USER-FLAGGED address supplied in this run`);
  if (concentrated) reasons.push(`${percent}% of observed initiated transfers went to one recipient`);
  return signal("COUNTERPARTY_PATTERN", "Counterparty pattern", status, { initiatedOutflows: outgoing.length, topRecipient: topAddress || null, topRecipientPercent: percent, userFlaggedMatches: matches.length }, `FLAG at ≥ ${rules.concentrationPercent}% across ≥ ${rules.concentrationMinOutflows} outflows, or any chain-matched user watchlist exposure`, status === "FLAG" ? `${reasons.join("; ")}. A user watchlist is not an official scam list, and concentration can have legitimate operational causes.` : "No configured watchlist exposure or concentrated initiated-outflow pattern was observed in the checked range.", matches.map((x) => source(x.id, x, "USER-FLAGGED counterparty exposure")), "send, approve, interact");
}

function signal(id, name, status, observed, rule, explanation, evidence, mattersFor) { return { id, name, status, observed, rule, mattersFor, explanation, evidence, limitations: "Bounded indexed-event coverage; token implementations may be non-standard." }; }

export function analyze(snapshot, input = {}) {
  const target = normalizeAddress(snapshot.target);
  const rules = validateRules(input.rules);
  const watchlist = Array.isArray(input.watchlist) ? input.watchlist.filter((x) => x && x.address && x.chainId && x.label) : [];
  const normalized = { ...snapshot, target, events: [...snapshot.events].sort((a, b) => a.blockNumber - b.blockNumber) };
  const signals = [ageSignal(normalized, rules), approvalSignal(normalized), rapidSignal(normalized, rules), counterpartySignal(normalized, rules, watchlist)].sort((a, b) => statusRank[a.status] - statusRank[b.status]);
  const evaluated = signals.filter((x) => x.status === "PASS" || x.status === "FLAG").length;
  const unknown = signals.filter((x) => x.status === "UNKNOWN").length;
  const stale = Date.now() - Date.parse(snapshot.capturedAt) > rules.maxAgeSeconds * 1000;
  const coverageStatus = !snapshot.coverage.complete || stale || evaluated < 3 ? "INSUFFICIENT_DATA" : "SUFFICIENT";
  const flags = signals.filter((x) => x.status === "FLAG");
  const riskLevel = coverageStatus === "SUFFICIENT" ? (flags.length >= 2 ? "HIGH" : flags.length === 1 ? "MEDIUM" : "LOW") : null;
  const headline = coverageStatus === "INSUFFICIENT_DATA" ? "Risk unassessed because minimum coverage was not met." : `${riskLevel} observed risk within the checked scope.`;
  return {
    engineVersion: ENGINE_VERSION,
    target,
    action: input.action || "interact",
    question: String(input.question || ""),
    rules,
    riskLevel,
    coverageStatus,
    headline,
    reasons: flags.map((x) => x.explanation),
    signals,
    coverage: { ...snapshot.coverage, applicable: 4, evaluated, unknown, stale, analysisBlock: snapshot.analysisBlock, analysisTime: snapshot.capturedAt },
    method: "HIGH requires two independent flagged signal families; MEDIUM requires one; LOW requires zero and sufficient coverage. Data gaps never become LOW.",
    disclaimer: "This is a bounded counterparty briefing, not a safety certification, criminal attribution, or scam prediction.",
  };
}
