# Clarity — testing

## What runs

```bash
pip install -r requirements-dev.txt      # pytest + genlayer-test (pinned)
python -m pytest tests/ -q               # 49 tests, fully offline, deterministic
```

Requires Python ≥ 3.12 (developed on 3.14) and the pinned
`genlayer-test`/`genlayer-py`. No network, no docker: the direct mode executes
real GenVM contract semantics in-process — storage, calldata round-trips,
transaction value + sender, nondeterministic blocks with **captured
validators**, and machine time.

## The two layers (never trust a transcription)

1. `tests/mirror.py` — an **independent re-implementation** of the
   deterministic rules (settlement math, grounding gates, tier
   classification, dispute demotion). Expectations are computed, not
   transcribed; if contract and mirror ever disagree, one of them is wrong
   and the test screams.
2. `tests/conftest.py` — a mock corpus of pages (permalink, archived PDF,
   mutable dashboard, plain text, 404, empty, scripts-only, prompt-injection
   page, unmocked URL) and LLM responses (well-formed, wrong quote, lacks
   date, unparseable, bad verdict names) plus `run_validator()` plumbing to
   swap mocks *between* the leader run and the validator re-run. VM time
   comes from the same channel the contract uses in production
   (`gl.message_raw["datetime"]`), warped per test.

## What is proven (49 tests)

### `tests/test_registry.py` — entry-point discipline
- every create/back/cancel/settlement gate the contract declares exists and
  fails with the documented `CLARITY:<CODE>` error
- minimum stake / backing, deadline windows, URL hygiene, founder-cannot-back,
  one-backing-per-address, faith cap ordering (doubt before faith), participant
  caps
- value is escrowed exactly (stake + Σ backings) and cancels refund everyone

### `tests/test_panel.py` — the evidence panel
- happy path: FULFILLED on permalink page with verbatim quote, digests,
  containment, tier, page date all stored
- every fail-closed fold to UNCLEAR: 404 (`BAD_STATUS`), empty body, empty
  text, unparseable LLM payload, bad verdict names, ungrounded FULFILLED
  (quote missing / too short / on a MUTABLE page / date missing / date after
  deadline), unrelated page, unmocked URL (strict mocks)
- prompt injection cannot create proof
- **validator equivalence**: swapping the page or the LLM answer between the
  leader run and the validator re-run makes the panel disagree (nothing
  written), while deterministic re-runs agree

### `tests/test_settlement.py` — money
- FULFILLED: stake returns, doubter pool streams to faithful proportionally;
  claims are pull-based and once-only
- BROKEN: half the stake burns, other half + faith forfeits stream to
  doubters; no-doubter case burns everything (nothing floats)
- UNCLEAR: everyone refunds full amounts
- the unassessed-after-grace path settles UNCLEAR with refunds
- odd splits: remainder burns (dust = 1 wei in the recorded case), never
  stranded; `get_settlement_preview` re-runs identical math before finalize
- the **global accounting invariant** is checked after every flow that moves
  value, with mirror-computed numbers

### `tests/test_dispute.py` — the demotion-only window
- one dispute per address; window closes on time; budget = 3 disputes
- a dispute that matches the standing verdict is rejected (kept, no
  settlement change)
- demotions work FULFILLED→BROKEN and BROKEN→UNCLEAR; an "improved" outcome
  (UNCLEAR sky→FULFILLED) is rejected
- demoted settlements pay out under the new (worse) verdict's rules

## Lint / static gates

```bash
genvm-lint lint contracts/clarity.py     # GenVM contract rules
python -m py_compile contracts/clarity.py tests/mirror.py
```

## CI

`.github/workflows/ci.yml` runs: `py_compile`, `genvm-lint`, the full test
suite, and the web build on Node 20 — all on every push and PR.
