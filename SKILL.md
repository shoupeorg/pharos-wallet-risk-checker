---
name: pharos-wallet-risk-checker
description: Produce a read-only, evidence-backed counterparty briefing for an address on Pharos Pacific Mainnet before sending, approving, or interacting.
---

# Pharos Wallet Risk Checker

Use the shared deterministic engine and official Pharos Chain MCP read tools only.

1. Validate a 20-byte address and chain ID 1672.
2. Interpret the intended action as `send`, `approve`, or `interact`; preserve the user's question.
3. Plan only these reads: `get_chain_info`, `get_block_number`, `get_logs`, `eth_call`, and `get_code`.
4. Retrieve the bounded window in inclusive pages of at most 1,000 blocks. Never replace a failed page with an empty history.
5. Deduplicate events by transaction hash and log index. Separate unsolicited inbound activity from initiated outgoing activity.
6. Reconcile discovered standard approvals with current `allowance` where feasible. Historical Approval alone is not current exposure.
7. Evaluate exactly the four published families with the shared engine. Keep coverage separate from risk, and return `INSUFFICIENT_DATA` when minimum coverage is not met.
8. Cite only observation IDs that exist in the report. Describe USER-FLAGGED entries as user supplied, not official reputation.
9. Say “LOW observed risk within the checked scope,” never “safe.” Do not accuse, certify, or predict scams.
10. Never request or use a private key, signer, wallet connection, approval, transaction, or broadcast tool.

If a model is unavailable, use the labeled deterministic fallback. A model must never invent evidence, accusations, probabilities, or numbers.
