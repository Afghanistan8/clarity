# Clarity — live end-to-end proof on Studionet

**Executed 2026-10-19** (UTC), contract
`0x7c1EbD696BaEd71fD526eF3A4ffA295Baf24b14A` (GenLayer **Studionet**, chain id
61999). The complete vow lifecycle was driven by `scripts/e2e.mjs` with **real
Studionet validators**, real web fetches, real model calls and real GEN
(devnet-scale value). Machine record: `deployment/live-e2e.json`; console
transcript: `deployment/e2e-log.txt`.

## Setup

- Guards: RPC `eth_chainId == 0xf22f` and CLI network `studionet` verified
  before anything ran.
- Evidence page: `demo/evidence.md` fetched from
  `https://raw.githubusercontent.com/Afghanistan8/clarity/main/demo/evidence.md`
  and its exact grounding sentence verified **before** any transaction.
- Three throwaway accounts generated for the run (keys in the gitignored
  `deployment/e2e-keys.json`), funded from the CLI keystore account
  `deployer` via `genlayer account send`.

## The vow

> "By 2026-10-19T23:06:40Z this live end-to-end test on GenLayer Studionet
> will be complete: the repository Afghanistan8/clarity contains
> demo/evidence.md, and that page contains, verbatim, the sentence marked
> 'CLARITY LIVE PROOF' quoted and timestamped below."

Stake **10 GEN**, deadline now + 240 s, evidence URL as above. Vow **#1**.

## Transactions

| Step          | Tx                                                                                                                                  |
|---------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `create_vow`  | `0x72307854687f6ce9902c3808eff85ba970e8a65848d44f37faf836f49d9abb73` — 10 GEN escrowed, state OPEN                                     |
| `back` DOUBT  | `0x69f62ac4f9eb8124d0bf0f0b4b1efa345d08719522bb4081c24d3cbc087d2201` — 1 GEN (doubt must exist before faith)                            |
| `back` FAITH  | `0x1ca94a90e01ebbc5b9240fc4edeed2d411d48a08a18238f2d0be2b6da5d4fb9a` — 1 GEN (faith cap: 1 ≤ 1)                                         |
| `assess`      | `0x48ae2907e550fec48d317c30f4b3d08a6df63e78b0e0d4077233bdcc87b28aee` — real panel, consensus reached (5 validators)                     |
| `finalize`    | `0x16c87f887229c0317430e7be58df3380b38de253de2feb458a4d14a8fbe2639a` — after the 900 s dispute window, state SETTLED                    |
| `claim`       | founder `0x4d65fbbff3a68cf18e6e4b1e3a13b29172d7aa41aef184f9b4c067583a144b94` — 10 GEN                                                   |
| `claim`       | faithful backer `0x1eb1116100097eafc0b7afb7aa404e291f159a395c7864e6e86ff77d0b387a49` — 2 GEN (1 own + 1 share of doubt pool)             |
| `claim`       | doubter `0x0bcac954877f106d35f76478ac17c97576aa34c6baba46b74a092bbb1573a28f` — correctly reverted (`NO_CLAIM`: nothing is owed)          |

## What the panel decided

The consensus run fetched the live raw.githubusercontent page and every
material field was agreed by the validator equivalence gate:

- HTTP status `200`, procedure `OK`
- provenance tier **2 = PERMALINK** (static text + `ETag`, no query string)
- verbatim quote contained in the page text (`contained = true`),
  `"CLARITY LIVE PROOF: this sentence is the verbatim evidence quote for the
  Studionet end-to-end test on 2026-10-19."`
- page date `2026-10-19` ≤ deadline day `2026-10-19`
- **Provisional verdict: FULFILLED** (reason `EVIDENCED`)

No dispute was raised during the 900 s window (none would apply — the page
backed the promise); `finalize` then settled deterministically.

## Final settlement (on-chain view `get_settlement`)

```json
{
  "verdict": 1, "reason": "EVIDENCED", "none": false,
  "burned": 0,
  "to_proposer": "10000000000000000000",
  "to_faith":    "1000000000000000000",
  "to_doubt":    0,
  "finalized_at": "2026-10-19T23:22:12Z"
}
```

- founder recovered the full **10 GEN** stake,
- the faithful backer received **2 GEN** (own 1 GEN + the 1 GEN doubter
  pool, shared pro-rata),
- the doubter lost the stake exactly as the rules dictate on FULFILLED and
  their attempt to claim was rejected by the contract,
- nothing was burned (clean FULFILLED, no fractional remainder dust).

## Accounting invariant, read on-chain after the run

```json
{
  "escrow":      "12000000000000000000",
  "unfinalized": 0,
  "outstanding": 0,
  "burned_total": 0,
  "dispatched": "12000000000000000000",
  "consistent": true
}
```

`escrow == unfinalized + outstanding + burned_total + dispatched` — every wei
held is explained by the deterministic rules, verified on-chain by
`get_invariant()`.

## Operational notes recorded during the run (honest lessons)

1. **Payable enforcement**: the first deployed version's `create_vow`/`back`
   lacked `@gl.public.write.payable`; the direct-mode test harness does not
   check this decorator, so the bug appeared only live
   ("called non-payable method … with non-zero value"). The contract was
   fixed and re-verified before this run; see `docs/DEPLOYMENT.md`.
2. **Deadline economics**: Studionet transactions land 10–60 s after
   signing; a deadline created at `now + 180 s` once landed *after* its own
   deadline (`DEADLINE_TOO_SOON` revert). The E2E uses a 240 s lead.
3. **Funding nonce races**: two back-to-back `genlayer account send`
   transfers from one keystore can overwrite each other's pending nonce; the
   script funds each address with retry + balance polling.

These were all fixed before the successful recorded run above — nothing was
modified between the final deployment and this run except the E2E driver
itself (whose sources are hashed in `deployment/manifest.json`).
