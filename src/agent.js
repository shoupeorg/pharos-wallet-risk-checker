const ACTIONS = ["send", "approve", "interact"];

export function interpretRequest(input = {}) {
  const question = String(input.question || "").trim();
  const lower = question.toLowerCase();
  let action = ACTIONS.includes(input.action) ? input.action : null;
  if (!action) {
    if (/approve|allowance|spender|permission/.test(lower)) action = "approve";
    else if (/send|transfer|pay/.test(lower)) action = "send";
    else action = "interact";
  }
  return {
    action,
    question,
    plan: ["Validate network and address", "Read bounded indexed history", "Reconcile discovered permissions", "Evaluate four deterministic signal families", "Explain evidence and gaps"],
    capability: "DETERMINISTIC_FALLBACK",
    explanation: "No public model credential is required. Intent routing is deterministic; chain reads, calculations, citations, and risk rules remain deterministic.",
  };
}

export function ensureEvidenceIntegrity(analysis, observations) {
  const ids = new Set(observations.map((x) => x.id));
  for (const signal of analysis.signals) for (const ref of signal.evidence) if (!ids.has(ref.id)) throw new Error(`Unknown evidence reference ${ref.id}`);
  return analysis;
}
