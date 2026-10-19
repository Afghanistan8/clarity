"""Assessment: equivalence-gated panel behavior, grounding gates, receipts."""

from conftest import (
    PERM_URL, ARCHIVE_URL, MUTABLE_URL, PLAIN_URL, DEAD_URL, EMPTY_URL,
    SCRIPT_URL, UNMOCKED_URL,
    PERMALINK_HTML, BROKEN_HTML, UNRELATED_HTML, INJECTION_HTML,
    SUCCESS_QUOTE, FAIL_QUOTE, SCRIPT_ONLY_HTML,
    llm_full, T, SECOND, default_mocks,
)
import mirror
import pytest


def create_deadline_passed_vow(c, vm, url=PERM_URL, deadline="2026-06-02T00:00:00Z",
                               create_at="2026-05-30T00:00:00Z",
                               assess_at="2026-06-03T00:00:00Z"):
    vm.warp(create_at)
    vm.value = 10 * SECOND
    vid = c.create_vow("The well will be finished", deadline, url)
    vm.warp(assess_at)   # deadline has passed
    return vid


def test_fulfilled_happy_path_with_receipt(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_FULFILLED
    v = c.get_vow(vid)
    assert v["state"] == mirror.STATE_PROVISIONAL
    assert v["assessed_n"] == 1
    assert v["dispute_deadline"] == mirror.ts_plus("2026-06-03T00:00:00Z", 900)
    ev = c.get_evidence(vid)
    assert ev["none"] is False
    assert ev["tier"] == mirror.TIER_PERMALINK
    assert ev["contained"] is True
    assert ev["quote"] == SUCCESS_QUOTE
    assert ev["page_date"] == "2026-05-20"
    import hashlib
    body = PERMALINK_HTML.encode("utf-8")
    assert ev["content_sha256"] == hashlib.sha256(body).hexdigest()
    assert len(ev["content_sha256"]) == 64
    # dispute window is open; finalize must be refused
    with vm.expect_revert("DISPUTE_WINDOW_OPEN"):
        c.finalize(vid)


def test_unrelated_page_is_unclear_not_fulfilled(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm, url=MUTABLE_URL, deadline="2026-06-01T00:00:00Z")
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("UNCLEAR", "", ""))
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_UNCLEAR
    ev = c.get_evidence(vid)
    assert ev["quote"] == ""
    st = c.get_settlement(vid)
    assert st["reason"] == "EVIDENCED"


def test_llm_unparseable_fails_closed(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", "{{{ not json")
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_UNCLEAR
    ev = c.get_evidence(vid)
    assert ev["procedure"] == 5      # PROC_UNPARSEABLE
    st = c.get_settlement(vid)
    assert st["reason"] == "EVIDENCE_UNPARSEABLE"


def test_bad_status_fails_closed(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm, url=DEAD_URL)
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_UNCLEAR
    ev = c.get_evidence(vid)
    assert ev["procedure"] == 1 and ev["status"] == 404


def test_empty_and_script_only_pages_fail_closed(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm, url=EMPTY_URL)
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    assert c.get_evidence(vid)["procedure"] == 3
    vid2 = create_deadline_passed_vow(c, vm, url=SCRIPT_URL, deadline="2026-06-04T00:00:00Z",
                                      assess_at="2026-06-05T00:00:00Z")
    assert c.assess(vid2) == mirror.VERDICT_UNCLEAR
    assert c.get_evidence(vid2)["procedure"] == 4


def test_unmocked_evidence_fails_closed(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm, url=UNMOCKED_URL)
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_UNCLEAR
    assert c.get_evidence(vid)["procedure"] == 2


def test_broken_page_produces_broken_verdict(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    # swap the evidence for the retraction page before assessing
    vm.clear_mocks()
    vm.mock_web(r"https://proof\.example/log/well-project$", {
        "method": "GET", "status": 200, "response": {
            "status": 200,
            "headers": {"Content-Type": "text/html; charset=utf-8",
                        "ETag": '"zzz"', "Last-Modified": "Wed, 21 May 2026 08:00:00 GMT"},
            "body": BROKEN_HTML.encode("utf-8"),
        }})
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-22"))
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_BROKEN
    ev = c.get_evidence(vid)
    assert ev["quote"] == FAIL_QUOTE and ev["contained"] is True
    st = c.get_settlement(vid)
    assert st["reason"] == "EVIDENCED"


def test_grounded_fulfilled_requires_quoted_proof(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    # a claim of fulfillment WITHOUT a quote fails closed
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", "", "2026-05-20"))
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    st = c.get_settlement(vid)
    assert st["reason"] == "UNGROUNDED"


def test_grounded_fulfilled_requires_long_quote(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    short = "Work is done."      # 13 chars < MIN_QUOTE_LEN(48)
    assert len(short) < 48
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", short, "2026-05-20"))
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    assert c.get_settlement(vid)["reason"] == "UNGROUNDED"


def test_grounded_fulfilled_requires_page_date_implies_deadline(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm, deadline="2026-05-10T00:00:00Z",
                                     create_at="2026-05-01T00:00:00Z")
    # page date AFTER deadline: a later "proof" cannot fulfill an earlier vow
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    assert c.get_settlement(vid)["reason"] == "UNGROUNDED"


def test_grounded_fulfilled_requires_no_missing_date(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, ""))
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    assert c.get_settlement(vid)["reason"] == "UNGROUNDED"


def test_tier_mutable_blocks_fulfillment(clarity):
    c, vm = clarity
    # MUTABLE page: even a true-looking success claim is not enough
    vid = create_deadline_passed_vow(c, vm, url=MUTABLE_URL, deadline="2026-06-01T00:00:00Z")
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    assert c.get_settlement(vid)["reason"] == "UNGROUNDED"
    assert c.get_evidence(vid)["tier"] == mirror.TIER_MUTABLE


def test_tier_snapshot_allows_fulfillment(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm, url=ARCHIVE_URL)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-19"))
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_FULFILLED
    ev = c.get_evidence(vid)
    assert ev["tier"] == mirror.TIER_SNAPSHOT   # pdf + memento header


def test_quote_must_really_be_on_page(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    # the judge fabricates a success quote that is NOT on the page: consensus
    # still agrees (both derive the same data), but `contained` is False, so
    # code refuses to grant FULFILLED.
    fabricated = "The entire well project finished two weeks ahead of schedule."
    assert fabricated not in PERMALINK_HTML
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", fabricated, "2026-05-20"))
    assert c.assess(vid) == mirror.VERDICT_UNCLEAR
    ev = c.get_evidence(vid)
    assert ev["contained"] is False
    assert c.get_settlement(vid)["reason"] == "UNGROUNDED"


def test_prompt_injection_cannot_create_proof(clarity):
    c, vm = clarity
    # the page tries to talk judges into fulfillment; stripped text contains no
    # success sentence, so nothing can be grounded.
    vm.clear_mocks()
    vm.mock_web(r"proof\.example/log/well-project$", {
        "method": "GET", "status": 200, "response": {
            "status": 200,
            "headers": {"Content-Type": "text/html; charset=utf-8",
                        "ETag": '"abc"', "Last-Modified": "Wed, 20 May 2026 08:00:00 GMT"},
            "body": INJECTION_HTML.encode("utf-8"),
        }})
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", "well project finished", ""))
    verdict = c.assess(vid)
    assert verdict == mirror.VERDICT_UNCLEAR
    ev = c.get_evidence(vid)
    assert ev["contained"] is False


def test_assess_budget_and_states(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    assert c.assess(vid) == mirror.VERDICT_FULFILLED
    # already provisional: cannot assess again
    with vm.expect_revert("NOT_OPEN"):
        c.assess(vid)


def test_assess_before_deadline_fails(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    vid = c.create_vow("v", "2026-06-30T00:00:00Z", PERM_URL)
    with vm.expect_revert("DEADLINE_NOT_PASSED"):
        c.assess(vid)


def test_validator_equivalence_same_page(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    c.assess(vid)
    # a validator re-running sees the same page and the same judgment -> agrees
    assert vm.run_validator() is True


def test_validator_disagrees_when_page_changes(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    c.assess(vid)
    # swap the evidence page: the validator now fetches something else
    vm.clear_mocks()
    vm.mock_web(r"proof\.example/log/well-project$", {
        "method": "GET", "status": 200, "response": {
            "status": 200,
            "headers": {"Content-Type": "text/html",
                        "ETag": '"abc"', "Last-Modified": "Wed, 20 May 2026 08:00:00 GMT"},
            "body": BROKEN_HTML.encode("utf-8"),
        }})
    assert vm.run_validator() is False    # disagree -> nothing would be written


def test_validator_disagrees_when_verdict_changes(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    c.assess(vid)
    # same page, but the validating judge now claims the promise was broken:
    # verdict fields must match exactly under equivalence.
    vm.clear_mocks()
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-20"))
    assert vm.run_validator() is False


def test_validator_leader_error_is_disagreement(clarity):
    c, vm = clarity
    vid = create_deadline_passed_vow(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    c.assess(vid)
    assert vm.run_validator(leader_error=Exception("fetch exploded")) is False
