# Clarity — live end-to-end on Studionet

Executed: **2026-10-19**, contract `0xABefC872823aB9aF8246c3E883529bBa4428bbF5`
(Studionet, chain id 61999), full lifecycle executed by `scripts/e2e.mjs`
with real validators, real fetches and real GEN (immaterial testnet value).

All receipts are in `deployment/live-e2e.json` (unchecked: it is
machine-generated output; this document records the run).

## What was run

1. Guards: CLI network + RPC `eth_chainId == 0xf22f`.
2. Evidence page proof: `demo/evidence.md` fetched from
   `raw.githubusercontent.com` and its exact grounding sentence verified
   **before** any tx.
3. Three throwaway accounts (founder / faithful / doubter) generated and
   funded from the CLI keystore account `deployer` via `genlayer account send`.
4. `create_vow(text, deadline=now+180s, url)` with a 10 GEN stake.
5. `back()` DOUBT 1 GEN, then `back()` FAITH 1 GEN d faith cap (doubt first).
6. Sleeped to the deadline; `assess()` executed the nondeterministic panel
   against Studionet validators.

Run transcript: see `deployment/live-e2e.json`
