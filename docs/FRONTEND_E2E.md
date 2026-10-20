# Frontend end-to-end proof — Studionet (chain 61999)

This document records the user journey of the **web interface** of Clarity, executed
in a real browser against the live Studionet RPC. Every transaction below was signed
inside the app's own write path (forms, drawer buttons), by a simulated wallet with a
real funded key — see *Why a browser harness?*. On-chain truth for every step was
re-verified with independent contract reads after each action.

> Contract under test: `0x7c1EbD696BaEd71fD526eF3A4ffA295Baf24b14A` (Studionet, chain
> 61999; SHA-verified against `deployment/manifest.json`).

## Why a browser harness?

The app only ever signs through an injected EIP-1193 wallet. For automation the
browser account is a simulated **OKX** wallet: it is announced over EIP-6963 under
the same `com.okex.wallet` rdns the real wallet uses, so the app's real
wallet-picker + connect flow runs unchanged. The simulated wallet signs Studionet
transactions with a real, funded throwaway key by replicating genlayer-js's own
local-account path byte-for-byte:

    eth_sendTransaction({from,to,data,value,gas}) →
      nonce  = client.getCurrentNonce()
      gas    = client.estimateTransactionGas()   (fallback 200 000)
      account.signTransaction({type:"legacy", …})
      client.sendRawTransaction({serializedTransaction})

Everything on-chain is identical to what a real OKX user would produce: the same
calldata envelope, the same legacy signature, the same broadcast RPC. The harness
lives in a local-only file (never committed) and boots keys from the URL fragment;
keys are stored only in the gitignored `deployment/frontend-e2e-keys.json`.

## Accounts (throwaway, funded from the CLI keystore "deployer")

| actor | address (`frontend-e2e-keys.json`) | funded | role |
|-------|------------------------------------|--------|------|
| fA | `0xBD4fb34FC0FBBf0236FB9D8Ea5eCfC944739c241` | 24 GEN | founder of both vows, founder-stake claims |
| fB | `0x232fA2E1ee8d72cD6d79019Ba6d500453571287E` | 4 GEN  | doubt-backer (vow 3), assess of vow 2 |
| fC | `0x0A458Dd1c48713830d431f0Cf4a8fA2a6B921c48` | 8 GEN  | faith-backer (vow 3) |

Funding tool: `scripts/fund-frontend-e2e.mjs` — balances verified by
`eth_getBalance` before any UI action.

## Evidence page

`https://raw.githubusercontent.com/Afghanistan8/clarity/main/demo/evidence-frontend.md`
— `text/plain`, ETag present → **PERMALINK (tier 2)**, status 200. Contains two
single-line timestamped sentences: `CLARITY FRONTEND PROOF ONE` (used by vow 2) and
`CLARITY FRONTEND PROOF TWO` (vow 3).

> Lesson (now in the repo): proof sentences must be single lines. The first version
> wrapped sentences across lines; the validator quoted them verbatim but the strict
> containment check failed → verdict **UNCLEAR (not grounded)**. The fail-closed
> design worked exactly as intended — ungrounded quotes can never count as
> FULFILLED. The file was re-pushed with single lines before vow 3's deadline.

## Journey (all clicks in the real UI)

### Vow #2 — "CLARITY FRONTEND PROOF ONE" — complete lifecycle ✅

1. **Wallet connect**: picker modal, OKX announced via EIP-6963, chip `0xBD4fb3…39c241`.
2. **Create** (fA): promise = the vow-one text; deadline `2026-10-20T09:59:00Z`;
   URL = evidence permalink; PERMALINK provenance pill shown pre-submit.
   - tx: [`0x1eef22507bf5c648912c3088b0c4ff28fd11444493728148eca0ec489eb5a134`] (10 GEN)
   - on-chain: `get_vow(2).state=OPEN`, text_sha256 matches, escrow +10 → 22.
3. **Deadline passed mid-run** → the Back widget correctly hides (DEADLINE_PASSED
   gate) and the assessor action appears.
4. **Assess** (fB): [`0x925bb76189d19e6865883594ffbbbd1844011ae85226ed1c40bedae8ca8485d5`]
   - evidence card: http 200, procedure OK, **PERMALINK**, page date 2026-10-20,
     quote captured — but `contained=false` (wrapped source lines) → provisional
     **UNCLEAR, reason=UNGROUNDED** (fail-closed).
5. **Finalize** after the dispute window: [`0xa57a5e883bebc6b91665fd08ebb66ba773f2fd26241dbefebb51c298509ab18d`]
   - receipt trail: `VOW_SETTLED verdict=UNCLEAR burned=0`; tiles: founder 10
     (refund), faith pool 0, doubt pool 0, burn 0.
6. **Founder claim** (fA, "Claim payout"):
   [`0xd6d604736a7c9c453f652bc98069717f37704a9751b117a561e47387c274362b`]
   - on-chain: `get_entitlement(2, fA) = {amount: 10e18, claimed: true}`.
   - stats after: dispatched 22 (12 + 10), invariant `consistent=true`.

Result: **fail-closed path verified end-to-end through the UI** — an ambiguous
promise benefits nobody; the founder's stake is refundable, nothing burns.

### Vow #3 — "CLARITY FRONTEND PROOF TWO" — create + both backings ✅

1. **Create** (fA, deadline `2026-10-20T12:53:00Z`):
   [`0x15f1a5935e684d7c63ad597a159c12d4f727c68146fbcdb04b262ee4c4a31e2e`]
   - on-chain: `get_vow(3)`: state OPEN(1), deadline 12:53, escrow 32, invariant
     `consistent=true`.
2. **Back DOUBT 1 GEN** (fB, drawer → side DOUBT → "Commit 1 GEN"):
   [`0x866be6e5d25a39a21c78795bc5f58f960852d6985357f643a9e75f35059335fe`]
   - on-chain: `doubt_total = 1e18, doubt_n = 1`.
3. **Back FAITH 1 GEN** (fC, side FAITH — faith cap ≤ doubt enforced by the UI copy
   and the contract): [`0x1cbf51bcc2a7c0506a5f78182243b00f1514d258552d51982a7079ee718b85e5`]
   - on-chain: `faith_total = 1e18, faith_n = 1`.

**Stopped here by the RPC wall** (see below). Vow 3 sits `OPEN` past its deadline,
fully funded on both sides, with all pool state live on-chain. Anyone may assess it
at any time (the evidence page now carries the single-line quote, so a rerun should
produce FULFILLED → founder 10 refunded + faith pool streamed to fC). If it is left
untouched, the 72 h grace (`FINALIZE_GRACE`) settles it UNCLEAR — all stakes
refundable — no later than 2026-10-23T12:53Z. The pooled payout path itself
(streaming the doubt pool to faithful backers, dual claims) was verified
contract-side in the CLI run: `deployment/live-e2e.json` (verdict FULFILLED,
`to_faith = 2e18` claimed by the faithful backer).

## RPC reality check (important for real users)

Studionet's public RPC applies three limiters to `gen_call` traffic:

| bucket | limit | window | note |
|--------|-------|--------|------|
| read | 300/min | per IP | raw `eth_*` reads — generous |
| standard | 500 | hour | **global**, all contract reads/writes share it |
| (burst) | 30/min | per IP | secondary gen_call burst cap |

The 500/hour bucket is continuously saturated by other users — windows of capacity
appear unpredictably and last on the order of minutes. The app works *through* 429s
rather than pretending they don't exist:

- `rc()` never paper-overs: rate-limited reads throw with `err.rateLimited`; the UI
  backs off adaptively and makes **zero requests while a tab is hidden**.
- First-load hunts at 4 s until data lands, then settles to 60 s.
- Drawer loads retry on a fast loop; `#vow=N` deep links jump straight to a vow.
- Receipt polling runs at 20 s (consensus takes minutes anyway); signing-path RPCs
  retry politely so a broadcast is never lost to a failed prepare step.

## Fix shipped during this run

- `demo/evidence-frontend.md` rewritten with single-line proof sentences.
- `App.jsx`: drawer-open retry hunt (2.5 s × 40), `#vow=N` deep link, 4 s first-load.
- `api.js`: receipt polls 20 s; optional same-origin dev RPC proxy.
- Deleting the scratch harness at the same time as this record lands in `main`.

## What the interface proved

- Wallet picker + OKX-first EIP-6963 discovery; auto-connect; chain chips.
- Vow creation with a real 10 GEN value through the injected wallet — twice.
- Deadlines and their UI gates (Back widget hidden post-deadline, assessor action).
- Assessment → evidence fetch → verdict pipeline (PERMALINK tier, status 200,
  quote captured, page date parsed, SHA tallies in the drawer).
- **Fail-closed on nothing**: ungrounded quote ⇒ UNCLEAR ⇒ founder-only refund,
  zero burn, no laundering of ambiguity into success.
- Settlement tiles + authoritative receipt trail in the drawer.
- Pull-based claim executed by the founder through the UI, verified on-chain.
- Doubt and faith backings through the drawer with cap enforcement.
- Invariant `consistent=true` at every checkpoint (escrow 12 → 22 → 32; every pool
  stream reconciled).

## Honest limits

- Vow 3's post-deadline steps (assess → finalize → claims) were not driven through
  the UI — the global `gen_call` bucket made each additional transaction a
  multi-minute lottery, and the run was cut at a clean, fully-funded mid-state
  (both sides backed, deadline passed, nothing asserted that was not verified).
- Nothing here was faked to fill a gap: every claim in this document maps to a
  transaction hash or a contract-read result, all mirrored in
  `deployment/frontend-e2e.json`.
