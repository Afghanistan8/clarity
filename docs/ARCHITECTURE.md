# Clarity: architecture

A single self-contained contract, a deterministic settlement machine, and a
thin chain-locked client. Nothing else.

```
                ┌───────────────────────────────────────────────┐
                │            GenLayer Studionet (61999)         │
                │                                               │
                │  founder ── create_vow(text, deadline, url)   │
                │      │                escrow 10 GEN          │
                │      │                                        │
                │  backers ── back(vid, FAITH | DOUBT, value)   │
                │      │        faith ≤ doubt always (cap)      │
                │      ▼                                        │
                │  deadline passes ── assess(vid)               │
                │      │                                        │
                │      │   ┌── nondeterministic block ───────┐  │
                │      │   │ leader: fetch(url) + judge LLM  │  │
                │      │   │ validator: re-run, compare ALL  │  │
                │      │   │ fields (equivalence gate)       │  │
                │      │   └─────────────────────────────────┘  │
                │      │                                        │
                │      │  deterministic conversion:             │
                │      │   procedure failures  → UNCLEAR        │
                │      │   ungrounded FULFILLED → UNCLEAR       │
                │      │   grounded FULFILLED  → FULFILLED      │
                │      │   grounded BROKEN     → BROKEN         │
                │      ▼                                        │
                │  PROVISIONAL (15 min dispute window)          │
                │      │  dispute(vid): re-run panel, verdict   │
                │      │  changes only DOWNWARD                 │
                │      ▼                                        │
                │  finalize(vid) → SETTLED                      │
                │      entitlements rebuilt, ledger accrued     │
                │      ▼                                        │
                │  claim(vid) — pull-based, paid to caller      │
                └───────────────────────────────────────────────┘
```

## 1. The contract (`contracts/clarity.py`)

One file, no imports besides the GenLayer standard library. Storage:

- `vows` — `TreeMap[u256, Vow]` (founder, text + sha, stake, deadline, state,
  dispute bookkeeping, evidence URL)
- `backings` — per-vow `TreeMap[Address, Backing]` (side, amount)
- `evidence` — per-vow `EvidenceRec` (HTTP status, body/text SHA-256, lengths,
  verbatim quote, page date, containment bit, provenance tier, procedure code)
- `settlements` — per-vow `SettlementRec` (verdict, reason, burn/payout split)
- `entitlements` / `paid` — per-vow `TreeMap[Address, u256]`
- `disputed_by` — one dispute per address per vow
- `log` — append-only audit trail (`ts, vow, code, detail`)
- global counters: `vow_count, escrow, burned_total, outstanding, dispatched`

Permission model: **no owner, no admin, no upgrade.** Every state change is
either initiated by the founder of *that* vow, a backer, or by anybody when
the rules allow (assess/finalize/claim are open entry points gated purely by
state and time).

## 2. Deterministic assessment

The only non-deterministic segment is the evidence panel:

1. The **leader** fetches the URL with `gl.nondet.web.get` (no redirects
   accepted implicitly, body bytes are hashed), strips scripts/styles into
   plain text, and asks the model with a strict JSON contract (verbatim
   quote ≥ 48 chars required for FULFILLED/BROKEN claims, page date, and an
   explicit untrusted-data fence in the prompt).
2. **Every validator re-runs the leader end-to-end** and compares *every*
   material field — verdict, quote, digests, lengths, status, tier, page
   date, containment. Any difference is a Disagree and nothing is written.
3. A deterministic conversion step then applies grounding gates. This keeps
   validator disagreement from becoming a settlement forcing function: an
   unequaled assessment cannot darken or brighten the verdict — it can only
   leave the vow in UNCLEAR territory (or dispute-demotion per gate rules).

## 3. Settlement math (`_settle_math` + preview mirror)

Given stake `P`, faith `F`, doubt `D`, verdict `v`:

| v          | burned                       | to_proposer | to_faith                  | to_doubt                    |
|------------|------------------------------|-------------|---------------------------|-----------------------------|
| FULFILLED  | 0 (+ remainder dust)         | P           | D (if F == 0: D burns)    | 0                           |
| BROKEN     | P//2 (+ remainder dust)      | 0           | 0                         | (P − P//2) + F (if D == 0: burned = P + F) |
| UNCLEAR    | 0                            | P           | 0                         | 0 (each backer refunds amt) |

Every share is `(amount * pool) // total` floor division; what cannot be
distributed is **burned**, never stranded. `get_settlement_preview`
deterministically re-runs this math for any verdict to show users what
*would* happen before they call `finalize`.

## 4. Invariant

Maintained on-chain and mirrored by the independent test mirror:

```
escrow == unfinalized_pool + outstanding + burned_total + dispatched
```

- `create_vow`/`back` add to escrow and unfinalized pool.
- `finalize` moves unfinalized → (outstanding + burned).
- `claim` moves outstanding → dispatched.
- `early_cancel` moves a whole unfinalized pool → dispatched.

`get_invariant()` is a public view — anyone can verify the escrow explains
itself at any time.

## 5. Web client (`web/`)

Plain Vite + React. Constraints:

- The **only signer** is the injected EIP-1193 provider. `genlayer-js` is
  used with a *string* account + `window.ethereum` provider, so signing
  methods route to the wallet and reads are plain RPC.
- The client is chain-locked: wrong-network refuses writes and offers an
  automatic `wallet_switchEthereumChain` / `wallet_addEthereumChain` to
  Studionet (61999).
- Client-side validation mirrors the contract (lengths, deadline windows,
  URL hygiene) and computes provenance tiers like the contract does, so a
  user sees *before* signing whether a FULFILLED verdict is even possible.
- The ledger, the invariant strip and the detail drawer are all read-models
  of public views; the audit log (`get_log`) is shown as "receipts".

## 6. Tooling

- `scripts/deploy.mjs` — hard Studionet guard (RPC + CLI config), SHA-256
  manifest, CLI deployment, receipt record.
- `scripts/verify.mjs` — re-verify manifest + byte-compare on-chain source.
- `scripts/e2e.mjs` — full live lifecycle with throwaway accounts funded
  from the CLI keystore; records everything into `deployment/live-e2e.json`.
- `tests/` — direct-mode GenVM semantics with an independent rule mirror
  (`tests/mirror.py`) so expectations are computed, not transcribed.
