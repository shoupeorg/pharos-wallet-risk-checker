import { readFile, unlink, writeFile } from "node:fs/promises";
import { Agent } from "undici";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = process.argv[2] || "https://pharos-wallet-risk-checker.shoupeorg.workers.dev";
const MCP_URL = "https://mcp.pharos.xyz/mcp";
const TOKEN = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HISTORY_BLOCKS = 5000;
const PAGE_BLOCKS = 1000;
const DISCOVERY_PAGE_BLOCKS = 500;
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const MCP_CALL_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const dispatcher = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
const progressUrl = new URL("../.capture-evidence-progress.json", import.meta.url);
const address = (topic) => `0x${topic.slice(-40).toLowerCase()}`;

const retryable = (error) => ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT"].includes(error?.cause?.code || error?.code)
  || error?.name === "TimeoutError";

async function boundedFetch(input, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(input, { ...init, dispatcher, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function api(path, body) {
  const requestKey = body ? crypto.randomUUID() : undefined;
  const response = await boundedFetch(`${origin}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, requestKey }) } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${result.error || JSON.stringify(result)}`);
  return result;
}

async function discoverCandidates() {
  const client = new Client({ name: "risk-evidence-selection", version: "1.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: boundedFetch,
    reconnectionOptions: { initialReconnectionDelay: 1_000, maxReconnectionDelay: 2_000, reconnectionDelayGrowFactor: 2, maxRetries: 2 }
  });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_CALL_TIMEOUT_MS, maxTotalTimeout: MCP_CALL_TIMEOUT_MS });
        const text = result.content?.find((item) => item.type === "text")?.text;
        if (result.isError || !text) throw new Error(`${name} returned no usable result`);
        return JSON.parse(text);
      } catch (error) {
        const timedOut = error?.code === -32001 || retryable(error);
        if (!timedOut || attempt === 2) throw new Error(`${MCP_URL} ${name} failed for ${JSON.stringify(args)} after ${attempt} bounded attempt(s): ${error.message}`, { cause: error });
        console.error(`${MCP_URL} ${name} timed out; bounded retry ${attempt + 1}/2`);
      }
    }
  };
  try {
    let progress = null;
    try { progress = JSON.parse(await readFile(progressUrl, "utf8")); } catch {}
    const validProgress = progress?.version === 1 && progress?.token === TOKEN.toLowerCase() && progress?.historyBlocks === HISTORY_BLOCKS && progress?.pageBlocks === DISCOVERY_PAGE_BLOCKS;
    const latest = validProgress ? BigInt(progress.latestBlock) : BigInt((await call("get_block_number")).blockNumber);
    const logs = validProgress && Array.isArray(progress.logs) ? progress.logs : [];
    const startOffset = validProgress ? BigInt(progress.nextOffset || 0) : 0n;
    for (let offset = startOffset; offset < BigInt(HISTORY_BLOCKS); offset += BigInt(DISCOVERY_PAGE_BLOCKS)) {
      const to = latest - offset;
      const from = to - BigInt(DISCOVERY_PAGE_BLOCKS - 1);
      logs.push(...await call("get_logs", { address: TOKEN, topics: [TRANSFER], fromBlock: from.toString(), toBlock: to.toString() }));
      await writeFile(progressUrl, `${JSON.stringify({ version: 1, token: TOKEN.toLowerCase(), historyBlocks: HISTORY_BLOCKS, pageBlocks: DISCOVERY_PAGE_BLOCKS, latestBlock: latest.toString(), nextOffset: Number(offset + BigInt(DISCOVERY_PAGE_BLOCKS)), logs })}\n`);
    }
    const stats = new Map();
    for (const log of logs) {
      const from = address(log.topics[1]);
      const to = address(log.topics[2]);
      const block = Number(BigInt(log.blockNumber));
      for (const [value, key] of [[from, "out"], [to, "in"]]) {
        if (/^0x0{40}$/.test(value)) continue;
        const row = stats.get(value) || { address: value, in: 0, out: 0, blocks: [], transfers: [] };
        row[key] += 1;
        row.blocks.push(block);
        row.transfers.push({
          direction: key === "in" ? "IN" : "OUT",
          block,
          transactionIndex: Number(BigInt(log.transactionIndex || 0)),
          logIndex: Number(BigInt(log.logIndex || 0)),
          counterparty: key === "in" ? from : to
        });
        stats.set(value, row);
      }
    }
    const ranked = [...stats.values()].map((row) => {
      const ordered = row.transfers.sort((a, b) => a.block - b.block || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
      const incoming = ordered.filter((event) => event.direction === "IN");
      const outgoing = ordered.filter((event) => event.direction === "OUT");
      const rapidPotential = incoming.filter((received) => outgoing.some((sent) => {
        const after = sent.block > received.block || (sent.block === received.block && (sent.transactionIndex > received.transactionIndex || (sent.transactionIndex === received.transactionIndex && sent.logIndex > received.logIndex)));
        return after && sent.block - received.block <= 10;
      })).length;
      const counts = new Map();
      for (const event of outgoing) counts.set(event.counterparty, (counts.get(event.counterparty) || 0) + 1);
      const topOutCount = Math.max(0, ...counts.values());
      return { address: row.address, in: row.in, out: row.out, events: row.in + row.out, span: Math.max(...row.blocks) - Math.min(...row.blocks), rapidPotential, topOutPercent: row.out ? Math.floor(topOutCount * 100 / row.out) : 0 };
    }).filter((row) => row.events >= 2 && row.events <= 40 && row.span >= 1200);
    const warningCandidates = ranked.filter((row) => row.rapidPotential > 0 || (row.out >= 3 && row.topOutPercent >= 80))
      .sort((a, b) => b.rapidPotential - a.rapidPotential || b.topOutPercent - a.topOutPercent || b.out - a.out)
      .slice(0, 6);
    const cleanCandidates = ranked.sort((a, b) => a.out - b.out || a.events - b.events).slice(0, 4);
    const candidates = [...new Map([...warningCandidates, ...cleanCandidates].map((row) => [row.address, row])).values()];
    return { latestBlock: latest.toString(), token: TOKEN.toLowerCase(), logCount: logs.length, candidates };
  } finally {
    try { await transport.terminateSession(); } catch {}
    await client.close();
  }
}

const rules = { historyBlocks: HISTORY_BLOCKS, pageBlocks: PAGE_BLOCKS };
const selection = await discoverCandidates();
const checked = [];
let clean = null;
let warning = null;
for (const candidate of selection.candidates) {
  const report = await api("/api/check", { target: candidate.address, action: "send", question: "Evaluate this active counterparty using corrected transaction-origin attribution.", rules });
  checked.push({ address: candidate.address, reportId: report.id, risk: report.analysis.riskLevel, statuses: Object.fromEntries(report.analysis.signals.map((signal) => [signal.id, signal.status])) });
  const allPass = report.analysis.signals.length === 4 && report.analysis.signals.every((signal) => signal.status === "PASS");
  if (!clean && report.snapshot.events.length > 0 && report.snapshot.identity.accountType === "EOA" && report.snapshot.coverage.attribution.complete && report.analysis.coverageStatus === "SUFFICIENT" && allPass) clean = report;
  if (!warning && report.analysis.coverageStatus === "SUFFICIENT" && ["MEDIUM", "HIGH"].includes(report.analysis.riskLevel)) warning = report;
  if (clean && warning) break;
}

if (!warning) {
  for (const target of ["0x912c9ade24d44d8922f0866d8dcb079f1363f647", "0x936564245b69f5a293b42cbd752e0ee3bb68b470"]) {
    const report = await api("/api/check", { target, action: "send", question: "Explain any warning using corrected transaction-origin attribution.", rules });
    checked.push({ address: target, reportId: report.id, risk: report.analysis.riskLevel, statuses: Object.fromEntries(report.analysis.signals.map((signal) => [signal.id, signal.status])) });
    if (report.analysis.coverageStatus === "SUFFICIENT" && ["MEDIUM", "HIGH"].includes(report.analysis.riskLevel)) { warning = report; break; }
  }
}

if (!clean) throw new Error(`No active all-four-PASS clean example was found in the bounded candidate set: ${JSON.stringify(checked)}`);
if (!warning) throw new Error(`No corrected warning example was found in the bounded candidate set: ${JSON.stringify(checked)}`);
const initiated = warning.snapshot.events.find((event) => event.type === "TRANSFER" && event.direction === "OUT" && event.initiationStatus === "VERIFIED");
if (!initiated) throw new Error("Corrected warning has no verified target-initiated counterparty for the configuration demonstration.");

const configured = await api(`/api/reports/${warning.id}/recheck`, { action: warning.inputs.action, question: "Re-evaluate this exact saved snapshot with my user-supplied watchlist.", rules: warning.inputs.rules, watchlist: [{ address: initiated.to, chainId: 1672, label: "Demo review", reason: "Reviewer-supplied configuration demonstration", provenance: "user supplied" }] });
if (configured.reusedSnapshotOf !== warning.id || JSON.stringify(configured.snapshot) !== JSON.stringify(warning.snapshot)) throw new Error("Configuration evidence did not reuse the exact warning snapshot.");
const warningRapid = warning.analysis.signals.find((signal) => signal.id === "RAPID_FLOW")?.observed;
const configuredRapid = configured.analysis.signals.find((signal) => signal.id === "RAPID_FLOW")?.observed;
if (JSON.stringify(warningRapid) !== JSON.stringify(configuredRapid)) throw new Error("Non-watchlist signal changed during exact-snapshot re-evaluation.");

for (const [name, value] of Object.entries({ "v1.1-live-clean": clean, "v1.1-live-warning": warning, "v1.1-live-config-change": configured })) await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
await writeFile(new URL("../evidence/v1.1-selection.json", import.meta.url), `${JSON.stringify({ engineVersion: clean.analysis.engineVersion, officialSource: MCP_URL, network: clean.snapshot.network, selection, checked, clean: { id: clean.id, address: clean.snapshot.target }, warning: { id: warning.id, address: warning.snapshot.target }, configured: { id: configured.id, reusedSnapshotOf: configured.reusedSnapshotOf } }, null, 2)}\n`);

const indexUrl = new URL("../public/index.html", import.meta.url);
let html = await readFile(indexUrl, "utf8");
html = html.replace(/data-target="0x[0-9a-f]{40}">Recorded warning example/, `data-target="${warning.snapshot.target}">Recorded warning example`)
  .replace(/data-target="0x[0-9a-f]{40}">Recorded clean example/, `data-target="${clean.snapshot.target}">Recorded clean example`);
await writeFile(indexUrl, html);
try { await unlink(progressUrl); } catch {}
console.log(JSON.stringify({ origin, engineVersion: clean.analysis.engineVersion, clean: { id: clean.id, address: clean.snapshot.target, events: clean.snapshot.events.length, risk: clean.analysis.riskLevel }, warning: { id: warning.id, address: warning.snapshot.target, risk: warning.analysis.riskLevel }, configured: { id: configured.id, risk: configured.analysis.riskLevel, reusedSnapshotOf: configured.reusedSnapshotOf }, checked }, null, 2));
