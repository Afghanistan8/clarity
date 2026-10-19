# Clarity — security & threat model

The product is money; the spec is fail-closed. The design principle applied
throughout: **any ambiguity resolves toward "nobody loses money unfairly, and
value never moves outside the rules"**.

## Trust inventory

| Trust thing                | Amount of trust needed                                        |
|----------------------------|----------------------------------------------------------------|
| Founder text/deadline/URL  | none — your own backer due diligence                            |
| Evidence page content      | none — validators hash what they fetch, quote must be verbatim   |
| LLM correctness            | minimal — a wrong/absent judgment degrades to UNCLEAR, never to payout-moving success |
| Validator honesty          | equivalence-gate — every validator re-runs the panel and must match the leader field-for-field |
| Consensus/mev              | the round may disagree → nothing written (no state change)      |
| This repository's web app  | zero keys, no backend, no analytics — reads are public RPC      |

## Attacks and their answers

### 1. "Make the judge say FULFILLED" (prompt injection)

The evidence page is untrusted data: the leader strips scripts/styles, drops
sentinel markers (`EVIDENCE-BEGIN/END`, `VOW-BEGIN/END`), and the prompt
fences the page between explicit markers with an authority disclaimer.
Grounding gates demand a **verbatim ≥ 48-char quote that literally appears
in the fetched text**, a snapshot/permalink tier, and a page date ≤ deadline
day. A page cannot mint a verdict it does not already contain as text.

Test coverage: `test_panel.py::test_prompt_injection_cannot_create_proof`.

### 2. Mutable page attack (rewriting history after the deadline)

Provenance tiering refuses to ground FULFILLED on pages without caching
fingerprints (`ETag`/`Last-Modified` + text-like content type, no query
string) — anything else is `MUTABLE` and folds FULFILLED → UNCLEAR. Strong
evidence is an archived snapshot (web.archive.org, perma.cc, memento header,
PDF/image bytes). Content and text SHA-256 digests are recorded for every
assessment, so contradicting assessments are publicly comparable.

### 3. Pay-me-by-fault (validator dispute asymmetry inside a round)

The equivalence gate makes malicious or flaky validators *fail closed*: if
the panel does not agree exactly on verdict, quote, digests, tier, dates and
status, nothing is written. Disagreement cannot force a verdict — it can
only block one.

### 4. Dispute-window laundering (buffing a verdict)

Disputes re-run the full panel and may only **demote** a verdict
(FULFILLED→BROKEN→UNCLEAR). An improved outcome can never be smuggled in
after the initial assessment; the demotion bit is on the evidence record and
the audit log records every dispute outcome. `max_assessments = 4` caps
rounds at 1 + 3 (independent judges with bounded bandwagon risk).

### 5. Value extraction by contract code paths

- **No admin/owner/upgrades.** There is no key that can move escrowed funds.
- **Pull-based claims.** The contract never dispatches value except to a
  caller with a positive unclaimed claim; re-entrancy is engineered away —
  founders cannot interfere mid-settlement; each `paid` map entry is a
  monotone marker and totals move deterministically.
- **Faith cap & one-backing-per-address** prevent mirror-pool stuffing.
- Remainder dust is **burned**, never stranded or swept.
- **No vacuum holes:** every path is covered by the accounting invariant,
  recomputed from storage by `get_invariant()`; production assertions
  (`assert consistent` at finalize/claim in tests) reject any violation.

### 6. Time games

Transaction time is taken from `gl.message_raw["datetime"]`, canonicalized
(on-chain and lexicographically comparable), used for deadline, dispute
window and finalize grace. An assessment before the discount is impossible:
`assess` refuses before the deadline; `finalize` refuses inside the window;
`finalize` on unassessed vows requires 72 h of silence. A founder can cancel
only while `OPEN` — never against backers inside PROVISIONAL/SETTLED.

### 7. Front-end trust

The web app holds no keys. The injected EIP-1193 wallet signs; the app
validates client-side only to give early feedback. Arcane cases (value
races, faith caps at high concurrency) are still gated on-chain; the client
can be wrong, the contract can't.

### 8. What you should NOT trust

- The Studionet testnet itself — funds are devnet-scale.
- Any single validator — that is why the equivalence gate exists.
- This repository's deployment scripts as a security boundary (they are a
  chain-locked relief pipe — they refuse foreign chains but don't control
  keystore policy; use your own keystore discipline).

## Failure modes (documented, not hidden)

| Failure                         | Resolution                                                        |
|---------------------------------|--------------------------------------------------------------------|
| Evidence page disappears        | assess → UNREACHABLE, UNCLEAR refunds                              |
| Page moves behind a paywall     | BAD_STATUS / EMPTY_BODY → UNCLEAR                                  |
| LLM cannot parse JSON           | UNPARSEABLE → UNCLEAR                                              |
| Validators disagree             | nothing written; dispute later or finalize UNCLEAR                 |
| Page rewritten to dark          | dispute demotes; digests show the difference                       |
| Odd split leaves dust           | dust burns (never stranded, never swept by "admin")                |
| Vow never assessed              | 72 h grace → full refunds via UNCLEAR                              |

## Known limitations (honest list)

1. **Studionet is a testnet.** GEN there is not real value; treat the system
   as a protocol demo, not a custody product.
2. LLM panel quality is the real-world limiting factor on verdict accuracy;
   the arithmetic never lets a bad verdict pay the wrong side more than the
   rules allow (UNCLEAR refunds are always the safety valve).
3. The equivalence gate requires validators to run identical procedures; a
   new contract version must keep prompts byte-stable across a dispute round.
4. `MAX_PARTICIPANTS = 64` caps dist-of-backing precision, not safety.
