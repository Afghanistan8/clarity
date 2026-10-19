"""Dispute flow: review window, one dispute per address, demotion only."""

from conftest import (
    PERM_URL, BROKEN_HTML, SUCCESS_QUOTE, FAIL_QUOTE,
    llm_full, SECOND, default_mocks,
)
import pytest
import mirror as M

ALICE = "0x1111111111111111111111111111111111111111"
BOB = "0x2222222222222222222222222222222222222222"


def _assessed_fulfilled(c, vm):
    vm.value = 10 * SECOND
    vid = c.create_vow("The well will be finished", "2026-06-02T00:00:00Z", PERM_URL)
    with vm.prank(ALICE):
        vm.value = 2 * SECOND
        c.back(vid, 2)
    vm.warp("2026-06-03T00:00:00Z")
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    assert c.assess(vid) == M.VERDICT_FULFILLED
    return vid


def test_dispute_demotes_fulfilled_to_broken(clarity):
    c, vm = clarity
    vid = _assessed_fulfilled(c, vm)
    # the disputer swaps the live evidence for the retraction page, then
    # forces a fresh assessment: validators still must agree among
    # themselves, but this new consensus demotes the verdict.
    vm.clear_mocks()
    vm.mock_web(r"proof\.example/log/well-project$", {
        "method": "GET", "status": 200, "response": {
            "status": 200,
            "headers": {"Content-Type": "text/html",
                        "ETag": '"abc"', "Last-Modified": "Tue, 21 May 2026 08:00:00 GMT"},
            "body": BROKEN_HTML.encode("utf-8"),
        }})
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-21"))
    with vm.prank(BOB):
        verdict = c.dispute(vid)
    assert verdict == M.VERDICT_BROKEN
    v = c.get_vow(vid)
    assert v["state"] == M.STATE_PROVISIONAL
    assert v["dispute_n"] == 1 and v["assessed_n"] == 2
    ev = c.get_evidence(vid)
    assert ev["demoted_by_dispute"] is True
    assert ev["quote"] == FAIL_QUOTE
    st = c.get_settlement(vid)
    assert st["reason"] == "DISPUTE_DEMOTED" and st["verdict"] == M.VERDICT_BROKEN
    # settlement must now reflect BROKEN economics
    assert st["burned"] == 5 * SECOND


def test_dispute_that_fails_to_demote_is_rejected(clarity):
    c, vm = clarity
    vid = _assessed_fulfilled(c, vm)
    # the fresh assessment still says FULFILLED: no demotion happens, and the
    # verdict/receipt of the first assessment stand.
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    with vm.prank(BOB):
        verdict = c.dispute(vid)
    assert verdict == M.VERDICT_FULFILLED
    v = c.get_vow(vid)
    assert v["dispute_n"] == 1
    st = c.get_settlement(vid)
    assert st["reason"] == "DISPUTE_REJECTED" and st["verdict"] == M.VERDICT_FULFILLED


def test_dispute_rules(clarity):
    c, vm = clarity
    vid = _assessed_fulfilled(c, vm)
    # one dispute per address
    with vm.prank(BOB):
        vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
        c.dispute(vid)
    with vm.prank(BOB):
        vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-21"))
        with vm.expect_revert("ALREADY_DISPUTED"):
            c.dispute(vid)
    # disputes budget: MAX_ASSESSMENTS-1 total (3 disputes after the initial)
    third = "0x3333333333333333333333333333333333333333"
    fourth = "0x4444444444444444444444444444444444444444"
    fifth = "0x5555555555555555555555555555555555555555"
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    with vm.prank(third):
        c.dispute(vid)     # dispute 2 of 3
    with vm.prank(fourth):
        c.dispute(vid)     # dispute 3 of 3
    with vm.prank(fifth):
        with vm.expect_revert("NO_DISPUTES_LEFT"):
            c.dispute(vid)
    # window closes: dispute refused, finalize allowed
    vm.warp("2026-06-03T00:16:00Z")
    with vm.prank(fourth):
        with vm.expect_revert("DISPUTE_WINDOW_CLOSED"):
            c.dispute(vid)
    with vm.expect_revert():
        c.dispute(vid)
    c.finalize(vid)
    assert c.get_vow(vid)["state"] == M.STATE_SETTLED


def test_dispute_requires_provisional(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    vid = c.create_vow("v", "2026-06-02T00:00:00Z", PERM_URL)
    with vm.expect_revert("NOT_PROVISIONAL"):
        c.dispute(vid)


def test_dispute_unclear_to_broken_demotes(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    vid = c.create_vow("The well will be finished", "2026-06-02T00:00:00Z", PERM_URL)
    vm.warp("2026-06-03T00:00:00Z")
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("UNCLEAR", "", ""))
    assert c.assess(vid) == M.VERDICT_UNCLEAR
    # a dispute brings the retraction page: UNCLEAR(2) demotes to BROKEN(1)
    vm.clear_mocks()
    vm.mock_web(r"proof\.example/log/well-project$", {
        "method": "GET", "status": 200, "response": {
            "status": 200,
            "headers": {"Content-Type": "text/html",
                        "ETag": '"abc"', "Last-Modified": "Tue, 21 May 2026 08:00:00 GMT"},
            "body": BROKEN_HTML.encode("utf-8"),
        }})
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-21"))
    with vm.prank(BOB):
        assert c.dispute(vid) == M.VERDICT_BROKEN
    st = c.get_settlement(vid)
    assert st["verdict"] == M.VERDICT_BROKEN
    assert st["reason"] == "DISPUTE_DEMOTED"


def test_dispute_demoted_settlement_flows(clarity):
    c, vm = clarity
    vid = _assessed_fulfilled(c, vm)
    vm.clear_mocks()
    vm.mock_web(r"proof\.example/log/well-project$", {
        "method": "GET", "status": 200, "response": {
            "status": 200,
            "headers": {"Content-Type": "text/html",
                        "ETag": '"abc"', "Last-Modified": "Tue, 21 May 2026 08:00:00 GMT"},
            "body": BROKEN_HTML.encode("utf-8"),
        }})
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-21"))
    with vm.prank(BOB):
        c.dispute(vid)
    vm.warp("2026-06-03T00:16:00Z")
    c.finalize(vid)
    st = c.get_settlement(vid)
    assert st["verdict"] == M.VERDICT_BROKEN
    inv = c.get_invariant()
    assert inv["consistent"] is True
    # the founder stake was halved; doubter ALICE wins
    assert st["burned"] == 5 * SECOND
    ent = c.get_entitlement(vid, ALICE)
    assert ent["amount"] == 2 * SECOND + (2 * SECOND * 5 * SECOND) // (2 * SECOND)
    with vm.prank(ALICE):
        assert c.claim(vid) == ent["amount"]
    assert c.get_stats()["dispatched"] == ent["amount"]
    inv = c.get_invariant()
    assert inv["consistent"] is True
