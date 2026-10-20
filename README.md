# Pharos Wallet Risk Checker

A read-only **counterparty briefing before interaction** for Pharos Pacific Mainnet. Enter a wallet or contract, choose whether you plan to send, approve, or interact, and inspect four deterministic on-chain signal families with evidence and explicit coverage.

> A LOW result means **low observed risk within the checked scope**. It is not a safety certificate, criminal attribution, or scam prediction.

## Public demo

- Demo: `https://pharos-wallet-risk-checker.shoupeorg.workers.dev`
- Network: Pharos Pacific Mainnet, chain ID `1672`
- Official read source: Pharos Chain MCP, `https://mcp.pharos.xyz/mcp`
- Explorer links: `https://pharosscan.xyz` (links only; explorer facts are never attributed to MCP)

## What the engine checks

| Signal family | Rule | Important limitation |
|---|---|---|
| Observed activity maturity | FLAG when the first supported event in the bounded range is no more than 120 blocks old; PASS only when the observed span is at least 1,200 blocks | First observed activity is not wallet creation or contract deployment time. |
| Current approval exposure | Discover standard Approval events, then reconcile `allowance(owner,spender)` at the analysis block; FLAG only when a discovered allowance remains effectively unlimited | Historical events do not enumerate all approvals; non-standard tokens can be UNKNOWN. |
| Rapid funding-to-initiated-outflow | For an EOA, verify `transaction.from == target`, then FLAG when a later outgoing event for the same token type follows an inbound event within 10 blocks | Exact block/transaction/log order is used, each outgoing is used once, and this does not trace the same token units. Contract token movement is not called transaction initiation. |
| Initiated counterparty pattern | For an EOA, verify `transaction.from == target`, then FLAG for a chain-matched USER-FLAGGED recipient or at least 80% concentration across at least 3 verified initiated outflows | `transferFrom`, liquidations, and protocol-caused token movement are excluded or UNKNOWN. A user watchlist is not an official blacklist. |

Thresholds are bounded and configurable. One flagged independent family produces MEDIUM, two or more produce HIGH, and zero produces LOW only when at least three families are evaluated and retrieval is complete and fresh. Otherwise the result is `INSUFFICIENT_DATA` and risk is unassessed. Correlated facts stay inside one family.

## Coverage and provenance

The core scans a bounded 5,000-block window. `get_logs` is paged at no more than 1,000 inclusive blocks and runs three indexed views per page: initiated Transfer, received Transfer, and owner Approval. Events are deduplicated by `transactionHash:logIndex`. Each report records requested/retrieved ranges, batch counts, failures, block, analysis time, raw relevant observations, rules, and evidence references.

The official MCP provides the current network, block, code, calls, and indexed logs. The official hosted MCP is rate-limited to 120 requests per minute per IP. Its hosted transaction broadcast tool is disabled, and this project does not call it.

Source verification is separate metadata. An EOA is established only after a successful empty `get_code` response. A failed code read makes account type and verification `UNKNOWN`. Bytecode establishes contract type but never “verified.” SocialScan's documented explorer API requires an API key; without a conclusive separately attributed response, verification is `UNKNOWN`, not `UNVERIFIED`. Explorer history may also have retention limits. See [data-foundation.json](evidence/data-foundation.json).

Official references:

- [Pharos Agent Center](https://www.pharos.xyz/agent-center)
- [Pharos documentation index](https://docs.pharos.xyz/llms.txt)
- [Official Pharos Chain MCP source](https://github.com/PharosNetwork/pharos-chain-mcp)
- [SocialScan developer API documentation](https://thehemera.gitbook.io/explorer-api)

## Real demonstrations

Corrected `risk-engine/1.1.0` evidence is versioned separately:

- `evidence/v1.1-live-clean.json`: an active real EOA with all four signal families evaluated PASS under unchanged rules.
- `evidence/v1.1-live-warning.json`: a real warning after verifying `transaction.from` for claimed target-initiated activity.
- `evidence/v1.1-live-config-change.json`: the exact warning snapshot re-evaluated with a USER-FLAGGED counterparty; all non-watchlist observations remain identical.
- `evidence/v1.1-selection.json`: bounded selection inputs, candidates checked, report IDs, and snapshot linkage.
- `evidence/missing-data.json`: a clearly labeled SIMULATED outage fixture proving failed retrieval does not become LOW.

The original `live-clean.json`, `live-warning.json`, and `live-config-change.json` remain unchanged historical records from `risk-engine/1.0.0`; they are not presented as corrected proof. Opening a saved report labels it historical, and a fresh failure never silently reuses it.

## Agent workflow

The public core needs no reviewer credential. A deterministic fallback interprets action intent, plans the allowlisted read investigation, invokes official read tools, applies the shared engine, validates evidence IDs, and explains findings and missing information. It is honestly labeled `DETERMINISTIC_FALLBACK`; there is no fake “thinking” animation and no paid LLM dependency. Skill, CLI, and web use the same engine.

## Run locally

```bash
npm ci
npm test
npm run build
node src/cli.js 0xYourAddress approve "Before I approve this spender, explain warning signs."
```

The CLI and web are read-only. There are no keys, signers, wallet connections, approvals, deployments, payments, signing, or transaction-broadcast paths.

## API

- `GET /api/meta` — network, engine, permissions
- `POST /api/check` — fresh live check and persisted report
- `GET /api/reports` — saved report summaries
- `GET /api/reports/:id` — historical saved report

## Reuse and new work

Reused from the earlier Event Monitor: official MCP transport, bounded log pagination, event provenance, and transaction-hash/log-index identity. Reused from Portfolio Assistant: D1 persistence pattern and the verified Pharos logo asset (`SHA-256 64B125A6A7C39004AE77670F25895465220BBC5B91ABEBCF76C33E2B2FE44938`). The risk model, four-family engine, action briefing, evidence timeline, watchlist handling, and interface are new.

## Tests

`npm test` covers injected MCP responses, all four families, pagination boundaries, deduplication, `transaction.from` attribution, EOA/contract/UNKNOWN account types, same-block transaction/log ordering, single-use outflow matching, spam versus initiated exposure, current allowance reconciliation, thresholds, same-snapshot watchlist re-evaluation, truncated/stale data, chain-specific watchlists, intent fallback, evidence integrity, persistence recovery, and the read-only tool allowlist. `npm run check` runs the full tests and production bundle.

## Privacy and limitations

Addresses and questions submitted to the public demo are persisted as public review evidence. Do not enter secrets or personal information. The scan is bounded to standard indexed ERC-20-style events; it is not comprehensive transaction discovery, cannot understand every token, and does not infer ownership, intent, or illegality.
