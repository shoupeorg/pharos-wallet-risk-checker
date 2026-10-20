import { writeFile } from "node:fs/promises";

const origin = process.argv[2] || "https://pharos-wallet-risk-checker.shoupeorg.workers.dev";
const candidates = {
  warning: "0x912c9ade24d44d8922f0866d8dcb079f1363f647",
  clean: "0x903cf528c0c54ecb99991a69e0e095589917a0ce",
};
async function check(body) {
  const response = await fetch(`${origin}/api/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, requestKey: crypto.randomUUID(), rules: { historyBlocks: 1000, pageBlocks: 1000, ...(body.rules || {}) } }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error || JSON.stringify(result)}`);
  return result;
}
async function saved(target, predicate) {
  const index = await (await fetch(`${origin}/api/reports`)).json();
  for (const row of index.reports || []) {
    if (row.target.toLowerCase() !== target.toLowerCase()) continue;
    const report = await (await fetch(`${origin}/api/reports/${row.id}`)).json();
    if (predicate(report)) return report;
  }
  return null;
}
const clean = (await saved(candidates.clean, (r) => r.analysis?.riskLevel === "LOW" && !(r.inputs?.watchlist || []).length)) || await check({ target: candidates.clean, action: "send", question: "Show why this has low observed risk within the checked scope." });
const warning = (await saved(candidates.warning, (r) => ["MEDIUM", "HIGH"].includes(r.analysis?.riskLevel) && !(r.inputs?.watchlist || []).length)) || await check({ target: candidates.warning, action: "send", question: "Explain the real warning signs in this bounded history." });
if (clean.analysis.coverageStatus !== "SUFFICIENT" || clean.analysis.riskLevel !== "LOW") throw new Error(`Clean candidate did not produce covered LOW: ${clean.analysis.coverageStatus}/${clean.analysis.riskLevel}`);
if (warning.analysis.coverageStatus !== "SUFFICIENT" || !["MEDIUM", "HIGH"].includes(warning.analysis.riskLevel)) throw new Error(`Warning candidate did not produce a warning: ${warning.analysis.coverageStatus}/${warning.analysis.riskLevel}`);
const outgoing = warning.snapshot.events.find((x) => x.type === "TRANSFER" && x.direction === "OUT");
if (!outgoing) throw new Error("Warning report has no initiated counterparty for the configuration demonstration.");
const configured = (await saved(candidates.warning, (r) => (r.inputs?.watchlist || []).some((x) => x.address?.toLowerCase() === outgoing.to.toLowerCase()))) || await check({ target: candidates.warning, action: "send", question: "Re-evaluate using my own watchlist.", watchlist: [{ address: outgoing.to, chainId: 1672, label: "Demo review", reason: "Reviewer-supplied configuration demonstration", provenance: "user supplied" }] });
for (const [name, value] of Object.entries({ "live-clean": clean, "live-warning": warning, "live-config-change": configured })) await writeFile(new URL(`../evidence/${name}.json`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
console.log(JSON.stringify({ origin, clean: { id: clean.id, address: clean.snapshot.target, risk: clean.analysis.riskLevel }, warning: { id: warning.id, address: warning.snapshot.target, risk: warning.analysis.riskLevel }, configured: { id: configured.id, risk: configured.analysis.riskLevel } }, null, 2));
