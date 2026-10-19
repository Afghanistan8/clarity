# Clarity — contract specification

Contract: `contracts/clarity.py` — one self-contained file (header
`# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }`).

Every violation raises `CLARITY:<CODE>` (optionally `:<detail>`).

## Constants (from `get_constants`)

| Name                  | Value          | Meaning                                        |
|-----------------------|----------------|------------------------------------------------|
| `MIN_VOW_STAKE`       | 10 GEN         | founder minimum stake                          |
| `MIN_BACKING`         | 1 GEN          | minimum single faith/doubt backing             |
| `MAX_PARTICIPANTS`    | 64             | max distinct backers per side per vow          |
| `MAX_VOW_TEXT`        | 2000 chars     | promise text cap                               |
| `MAX_EVIDENCE_URL`    | 400 chars      | evidence URL cap                               |
| `MIN_QUOTE_LEN`       | 48 chars       | verbatim quote needed to ground FULFILLED      |
| `MAX_QUOTE_LEN`       | 600 chars      | stored quote cap                               |
| `MAX_DEADLINE_SPAN`   | 365 days       | deadline max lead                              |
| `MIN_DEADLINE_LEAD`   | 5 s            | deadline minimum lead                          |
| `DISPUTE_WINDOW`      | 900 s          | demotion-only review window after assessment   |
| `FINALIZE_GRACE`      | 72 h           | unassessed vows settle (UNCLEAR) after this    |
| `MAX_ASSESSMENTS`     | 4              | 1 initial panel + 3 disputes                   |

Verdicts: `FULFILLED=1`, `BROKEN=2`, `UNCLEAR=3`; rank order 1 < 2 < 3
(disputes only lower rank). States: `OPEN=1`, `PROVISIONAL=2`, `SETTLED=3`,
`CANCELLED=4`. Provenance tiers: `NONE=0`, `SNAPSHOT=1`, `PERMALINK=2`,
`MUTABLE=3`. Procedure codes: `NONE=0`, `OK=1`, `BAD_STATUS=2`,
`EMPTY_BODY=3`, `EMPTY_TEXT=4`, `UNPARSEABLE=5`.

## Writes

### `create_vow(text, deadline: "YYYY-MM-DDTHH:MM:SSZ", evidence_url)` — payable, founder

- Text non-empty, ≤ 2000 chars.
- URL must be https, no credentials, no query string, ≤ 400 chars.
- Deadline ≥ now + 5 s, ≤ now + 365 d.
- `msg.value ≥ 10 GEN` escrowed for the vow; state `OPEN`, `escrow +=`.

Errors: `TEXT_EMPTY`, `TEXT_TOO_LONG`, `URL_BAD`, `DEADLINE_TOO_SOON`,
`DEADLINE_TOO_FAR`, `STAKE_TOO_LOW`.

### `set_evidence(vow_id, evidence_url)` — founder, `OPEN` only

Same URL rules; logged as `EVIDENCE_SET`. Cannot run once the deadline has
passed (state gate).

### `early_cancel(vow_id)` — founder, `OPEN` only

Refunds stake to founder and every backing to its owner (pull handled inline
via `emit_transfer` from the escrow). State `CANCELLED`. Errors: `NOT_FOUND`,
`NOT_OPEN`.

### `back(vow_id, side: 1|2)` — payable, third party, `OPEN` only

- `side = 1` (FAITH) or `2` (DOUBT); `msg.value ≥ 1 GEN`.
- One backing per address per vow.
- **FAITH CAP:** `faith_total + amount ≤ doubt_total`. The first backer of a
  vow with no doubt must doubt — faith can never outrun scepticism.
- Errors: `NOT_OPEN`, `DEADLINE_PASSED`, `FOUNDER_CANNOT_BACK`, `BAD_SIDE`,
  `BACKING_TOO_SMALL`, `ALREADY_BACKED`, `FAITH_CAP`, `FAITH_FULL`,
  `DOUBT_FULL`.

### `assess(vow_id) -> verdict` — anybody, `OPEN` only

Gates: deadline passed (`DEADLINE_NOT_PASSED`), budget left
(`NO_ASSESSMENTS_LEFT`), evidence set.

Runs the non-deterministic panel (below), stores the deterministic
`EvidenceRec`, sets state `PROVISIONAL`,
`dispute_deadline = now + 900 s`, rebuilds entitlements for the provisional
verdict. The verdict recorded is:

- any procedure failure (`BAD_STATUS`, `EMPTY_BODY`, `EMPTY_TEXT`,
  `UNPARSEABLE`) → **UNCLEAR**, reason `UNPARSEABLE`/`UNREACHABLE`;
- validator-equivalent judgement `FULFILLED` counts only when
  `quote ⊂ page text` **and** `len(quote) ≥ 48` **and** tier ∈ {SNAPSHOT,
  PERMALINK} **and** page date ≤ deadline day; otherwise reason
  `UNGROUNDED` and **UNCLEAR**;
- `BROKEN` holds even without a page date, since it is a loss
  acknowledgement (fail-closed direction), but still requires procedure OK.

### `dispute(vow_id) -> verdict` — anybody, `PROVISIONAL` only

Gates: window open (`DISPUTE_WINDOW_CLOSED`), budget
(`NO_DISPUTES_LEFT`), one per address (`ALREADY_DISPUTED`).

Re-runs the full panel against the *current* page. If the fresh verdict has
a **lower rank** than the standing one (1→2→3 direction: FULFILLED→BROKEN,
FULFILLED→UNCLEAR, BROKEN→UNCLEAR), it demotes and the settlement record is
rebuilt (`reason = DISPUTE_DEMOTED`). Anything else is rejected: the old
verdict stands (`DISPUTE_REJECTED`). The demotion bit is stored on the
evidence record for the audit trail.

### `finalize(vow_id)` — anybody

- `PROVISIONAL`: requires window closed first (`DISPUTE_WINDOW_OPEN`);
  burns the settlement's burn plus the proportional-share remainder dust;
  moves unfinalized escrow → `outstanding` (+ `burned_total`); sets `SETTLED`.
- `OPEN` and deadline ≥ 72 h old without any assessment: writes an empty
  evidence record, verdict **UNCLEAR** reason `UNASSESSED`, full refunds.
- Errors: `DEADLINE_NOT_PASSED`, `GRACE_NOT_PASSED`, `NOT_SETTLABLE`,
  `DISPUTE_WINDOW_OPEN`.

### `claim(vow_id) -> amount` — pull-based, `SETTLED` (or `CANCELLED`)

Pays exactly the caller's stored entitlement with `emit_transfer` and marks
it paid. Errors: `NOT_SETTLED`, `NO_CLAIM`, `ALREADY_CLAIMED`.

## Settlement math

Let `P` = stake, `F` = faith total, `D` = doubt total.

| Verdict    | burned            | to_proposer | to_faith | to_doubt        | notes                                     |
|------------|--------------------|-------------|----------|-----------------|-------------------------------------------|
| FULFILLED  | 0 (+remaidst)      | P           | D        | 0               | if F == 0 → burned = D                     |
| BROKEN     | P // 2 (+remaidst) | 0           | 0        | (P − P//2) + F  | if D == 0 → burned = P + F (nothing floats)|
| UNCLEAR    | 0                  | P           | 0        | 0               | each backer refunds own amount             |

Distribution: each participant on the winning side gets `own_amt + (own_amt
× pool) // side_total` (floor). The pool minus Σ shares (**remainder dust**)
is burned at finalize. Two invariants make this safe:

1. `Σ entitlements + burned == P + F + D` exactly, per vow, per verdict.
2. Globally: `escrow == unfinalized_pool + outstanding + burned_total +
   dispatched` (public view `get_invariant()` recomputes the whole thing).

## Evidence panel (nondeterministic block)

Leader procedure (also re-run by every validator for equivalence):

1. `gl.nondet.web.get(url)` — network fetch. Exception → `UNREACHABLE`.
2. HTTP status outside 200–399 → `BAD_STATUS`; empty body → `EMPTY_BODY`.
3. HTML → text: drop `script|style|head|noscript|template|iframe|svg`,
   comments, and sentinel markers (`EVIDENCE-BEGIN/END`, `VOW-BEGIN/END` —
   prompt-injection fence), then tag-based line breaks, entity decoding,
   whitespace collapse; text cap 12 000 chars. Empty text → `EMPTY_TEXT`.
4. Record SHA-256 of raw body and of extracted text, body/text lengths.
5. Tier: archive host or `Memento-Datetime` or PDF/image content type →
   `SNAPSHOT`; `text/html`|`text/plain` + (`ETag`|`Last-Modified`) and no
   query string → `PERMALINK`; otherwise `MUTABLE`.
6. LLM judgment via `gl.nondet.exec_prompt` with a strict JSON contract and
   an untrusted-data fence; verdict must be one of the three names, quote
   capped at 600 chars, `evidence_date` normalized to `YYYY-MM-DD`.

Validator gate: byte-equal comparison of **every** material field with the
leader's result. Disagreement → nothing written (the assessment call fails
with no state change).

## Panels & views

| View                     | Returns                                                            |
|--------------------------|--------------------------------------------------------------------|
| `get_constants()`        | constants (above)                                                  |
| `get_vow_ids()`          | list of vow ids                                                    |
| `get_vow(id)`            | full vow record incl. dispute state counters                       |
| `get_vow_summaries(n)`   | last n vows (id, text head, state, stake, pools, deadline)          |
| `get_backings(id)`       | `[{address, side: "FAITH"\|"DOUBT", amount}]` (storage order)       |
| `get_evidence(id)`       | `EvidenceRec` or `{none: true}`                                    |
| `get_settlement(id)`     | verdict, reason, burn/payout split or `{none: true}`               |
| `get_settlement_preview(id)` | deterministic preview of what finalize *would* do              |
| `get_entitlement(id, who)` | `{present, amount, claimed}`                                      |
| `get_log(n)`             | last n audit entries `{ts, vow, code, detail}`                     |
| `get_stats()`            | `escrow, burned_total, outstanding, dispatched, vow_count`         |
| `get_invariant()`        | all of the above + `unfinalized` + `consistent: bool`              |

Audit log codes: `VOW_CREATED`, `VOW_BACKED`, `EVIDENCE_SET`,
`REFUND_BACKING`, `VOW_CANCELLED`, `ASSESSED`, `DISPUTE_DEMOTED`,
`DISPUTE_REJECTED`, `VOW_SETTLED`, `CLAIMED`.

## Deployment/destructability

No constructor arguments; mutable state only through the entry points above.
There is **no** owner, admin, upgrade, pause, or sweep entry point. The
contract cannot move value except by paying a caller that holds a positive
unclaimed entitlement in a settled vow.
