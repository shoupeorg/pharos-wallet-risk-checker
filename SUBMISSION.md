# Submission notes

Pharos Wallet Risk Checker is a read-only counterparty briefing for Pharos Pacific Mainnet. It uses official Pharos Chain MCP history and calls to evaluate four distinct, explainable signal families: observed activity maturity, reconciled approval exposure, rapid funding-to-outflow, and counterparty/watchlist patterns. Coverage is independent from risk, failed history never becomes LOW, and every flag expands to transaction/block/log evidence.

The public reviewer can inspect real clean and warning-bearing reports, change a rule or user watchlist entry, reopen persisted history, and run an arbitrary supported address without login or wallet connection. The agent entry point uses a credential-free deterministic tool plan and shared engine; no LLM dependency, signing, broadcast, or spending exists.

## Recording guide

1. Open the demo and click **Recorded clean example**, then **CHECK COUNTERPARTY**.
2. Expand **Four signal families** and one transaction evidence link.
3. Click **Recorded warning example**, then **CHECK COUNTERPARTY**; show the specific warning and coverage.
4. Add a **Watchlist address**, enter a reason, and click **CHECK COUNTERPARTY** again to show a USER-FLAGGED change.
5. Refresh, then open the result under **Saved briefings** to show the **HISTORICAL SAVED REPORT** label.
