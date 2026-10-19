# Clarity

Public promises with real stakes, settled by consensus.

A founder posts a **vow** — a concrete public promise with a deadline and one
evidence URL — and escrows a **GEN stake**. Anyone can **doubt** it (and only
after doubt exists, back it in **faith**; the contract caps faith at doubt, so
hope is always collateralised by scepticism). After the deadline, a panel of
**consensus validators** independently fetches the evidence page and judges
it. Settlement is deterministic and **fail-closed**:

| Verdict     | Meaning                                   | Money                                                              |
|-------------|-------------------------------------------|--------------------------------------------------------------------|
| FULFILLED   | page proves the promise (verbatim quote)  | stake returned, doubter pool streams to the faithful               |
| BROKEN      | page proves the failure                   | half the stake is **burned**, the rest + faith forfeits → doubters |
| UNCLEAR     | unprovable, unreadable, disputed, absent  | everything refunds                                                 |

Counter-evidence during the dispute window can **only demote** a verdict —
never upgrade one. Claims are **pull-based**; there are **no admin keys, no
upgrade path**, and an on-chain accounting invariant keeps every wei
explainable:

```
escrow == unfinalized_pool + outstanding + burned_total + dispatched
```

## Status

- **Contract**: deployed on GenLayer **Studionet** (chain id 61999) at
  [`0xABefC872823aB9aF8246c3E883529bBa4428bbF5`](https://studio.genlayer.com)
  — see `deployment/studionet.json` and `docs/DEPLOYMENT.md`.
- **Tests**: 49 deterministic direct-mode tests exercise real GenVM contract
  semantics (storage, calldata, nondeterministic blocks with captured
  validators). See `docs/TESTING.md`.
- **End-to-end**: a live run against Studionet with real validators and real
  GEN is recorded in `docs/END_TO_END.md` + `deployment/live-e2e.json`.
- **Web app**: React + Vite, injected EIP-1193 wallet only, chain-locked to
  Studionet (`web/`).

Browse the app by opening `web/index.html` with `npm run dev` from `web/`.

## Repository layout

```
contracts/clarity.py     the contract (self-contained, single file)
tests/                   direct-mode test suite + independent mirror (mirror.py)
scripts/                 deploy.mjs / verify.mjs / e2e.mjs (Studionet-locked)
web/                     React front end (injected EIP-1193 wallet only)
demo/evidence.md         the live evidence page for the end-to-end run
docs/                    architecture, spec, threat model, reports
deployment/              deploy receipts, SHA manifest, e2e artifacts
```

## Documentation

- `docs/ARCHITECTURE.md` — how the pieces fit together
- `docs/CONTRACT_SPEC.md` — callable surface, settlement math, event codes
- `docs/THREAT_MODEL.md` — attack surface and failure modes (Security)
- `docs/DEPLOYMENT.md` — how Studionet deployment was done and can be redone
- `docs/TESTING.md` — what the test suite proves and how to run it
- `docs/REVIEW_TARGET.md` — what a reviewer should attack first
- `docs/END_TO_END.md` — the recorded live run

## Toolchain

Contract: Python 3.12+, `genlayer-py` / `genlayer-test` (direct mode), the
GenVM toolchain (`genlayer` CLI for deployment & calls).
Web: Node 20+, Vite 5, React 18, `genlayer-js` pinned at **1.1.8**.
See `pyproject.toml` / `package.json` for pinned versions.
