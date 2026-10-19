# Clarity — REVIEW_TARGET.md

If you are reviewing this project, start here. These are the seven places
where a real attack or a real bug would live, in priority order.

## 1 · Deterministic settlement math (`_settle_math`, `_pending_extra`)

`contracts/clarity.py`, and `tests/mirror.py` (same rules, written
independently). Freeze on:

- FULFILLED with zero faithful backers on a vow that *has* doubt — pool
  `D` on victory: does it burn? (it must, nothing may float)
- BROKEN with zero doubters (possible under the faith cap when nobody
  doubted at all) — `burned == P + F` (all of it).
- Share flooring: `(amt * pool) // total` sums to ≤ pool, and the **exact
  remainder** (not rounded up, never negative) is burned — test
  `test_no_value_is_stranded_on_odd_split` uses 1-wei dust to prove the
  bound.

**The invariant to kill**: `escrow == unfinalized + outstanding + burned +
dispatched` computed entirely from storage (`get_invariant`). Any
arithmetic hole (double count, missing refund, sweep) breaks it.

## 2 · Panel equivalence gate (`assess` / `dispute`, `run_nondet_unsafe`)

The leader fetches + judges; every validator re-runs the *same* code against
its own fetch/LLM and must match **every material field**. Attack via:

- swapping mocks between the leader run and the validator re-run
  (`tests/test_panel.py::test_validator_disagree...`) — verify no state
  mutation happens (verdict UNCLEAR, no settlement record change);
- try to smuggle a difference in a *non-material* field that would later
  influence money (tier/status/length are all material — is anything
  missing from the comparison list?).

## 3 · The grounding gates (fail-closed conversions)

Between the panel result and the stored verdict, `assess` declares FULFILLED
valid only when quote ⊂ text ∧ len ≥ 48 ∧ tier ∈ {SNAPSHOT, PERMALINK} ∧
page_date ≤ deadline day. Try to ground with: a quote from a different page,
a 47-char quote, a query-string URL, a mutable dashboard, a "page date"
parsed from nowhere, a deadline same-day page-date but UTC-vs-local skew.
`tests/test_panel.py` covers these; the interesting question is whether some
path (e.g. `set_evidence` before deadline, or `dispute`) bypasses a gate the
initial assess applies.

## 4 · State machine holes

Opening up `assess/finalize/claim` to *anybody* is deliberate (no admin
keys). Look for:

- `assess` on a CANCELLED or SETTLED vow (state gates) — retry/replay
- `finalize` inside the window, or on OPEN before the 72 h grace
- `claim` after a dispute demotion — entitlement map is rebuilt per verdict;
  is *only* the current verdict's map claimable? (old provisional maps must
  not pay)
- `early_cancel` against backers after the deadline — must be impossible
  (state OPEN only).

## 5 · Prompt-injection fences

`_strip_html` + sentinel scrub + prompt ordering. The tests feed an
INJECTION_HTML page that orders the judge to answer FULFILLED. Think:
HTML entity tricks (`&#86;`), nested script tags, attribute-whitespace
splits (`<scr<script>ipt>`), image alt text spoofing, or unicode homoglyphs
of sentinel markers. Nothing here can mint value through a quote that isn't
literally in the stripped text — but a *crafted* page could still try to
plant a quote-shaped sentence. That's what the page-date grounding and the
quoted-quote cap (600) bound.

## 6 · Dispute demotion-only rule

`dispute` re-runs the panel with the CURRENT page. If the page was fixed to
look fulfilling, a dispute cannot upgrade (good). But check the direction of
the comparison itself (`_VERDICT_RANK`) and the settlement rebuild:
`DISPUTE_REJECTED` must reuse the *old* settlement record contents (order of
rebuild vs. demotion flag flip matters — the evidence record must carry
`demoted_by_dispute` only on genuine demotions).

## 7 · Web client honesty

`web/src/api.js` + `web/src/App.jsx`. There is no backend, no keys — but
check that:

- the client cannot hide a wrong network: every write goes through a
  hardcoded Studionet chain object;
- what the user reads (ledger, preview) is produced by the contract's views,
  not by client-side recomputation;
- the only client-side math (provenance preview, deadline validation) is
  duplicated on-chain anyway — being wrong costs one reverted transaction.
