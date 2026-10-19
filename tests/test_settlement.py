"""Settlement: dispute windows, entitlement math, claims, burns.

Entitlement expectations are computed with tests/mirror.py — an independent
implementation of the same deterministic rules — and compared against the
contract address by address.
"""

from conftest import (
    PERM_URL, SUCCESS_QUOTE, FAIL_QUOTE, llm_full, SECOND,
)
import pytest
import mirror as M

ALICE = "0x1111111111111111111111111111111111111111"
BOB = "0x2222222222222222222222222222222222222222"
CAROL = "0x3333333333333333333333333333333333333333"
DAVE = "0x4444444444444444444444444444444444444444"
EVE = "0x5555555555555555555555555555555555555555"

SIDE_FAITH = 1
SIDE_DOUBT = 2


def _pass_deadline(c, vm, backs=(), url=PERM_URL, deadline="2026-06-02T00:00:00Z"):
    """Create a vow (10 GEN stake), apply backings BEFORE the deadline, then
    warp past it so the vow is assessable."""
    vm.value = 10 * SECOND
    vid = c.create_vow("The well will be finished", deadline, url)
    for addr, side, amount in backs:
        vm.value = amount
        with vm.prank(addr):
            c.back(vid, side)
    vm.warp("2026-06-03T00:00:00Z")
    return vid


def _past_window(vm):
    vm.warp("2026-06-03T00:16:00Z")   # 16 minutes after assessment


def test_fulfilled_settlement(clarity):
    c, vm = clarity
    vid = _pass_deadline(c, vm, backs=(
        (ALICE, SIDE_DOUBT, 5 * SECOND),
        (BOB, SIDE_DOUBT, 3 * SECOND),
        (CAROL, SIDE_FAITH, 4 * SECOND),   # faith cap ok: 4 <= 8
    ))
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    assert c.assess(vid) == M.VERDICT_FULFILLED

    # inside the review window finalize is refused
    with vm.expect_revert("DISPUTE_WINDOW_OPEN"):
        c.finalize(vid)
    _past_window(vm)
    c.finalize(vid)
    v = c.get_vow(vid)
    assert v["state"] == M.STATE_SETTLED
    st = c.get_settlement(vid)
    assert st["verdict"] == M.VERDICT_FULFILLED
    assert st["to_proposer"] == 10 * SECOND

    # independent mirror math
    ents, burned = M.entitlements_for({
        ALICE: (SIDE_DOUBT, 5 * SECOND),
        BOB: (SIDE_DOUBT, 3 * SECOND),
        CAROL: (SIDE_FAITH, 4 * SECOND),
    }, 10 * SECOND, M.VERDICT_FULFILLED)
    assert st["burned"] == burned == 0
    assert st["to_faith"] == 8 * SECOND
    # faith backer receives own stake + proportional share of the doubter pool
    assert c.get_entitlement(vid, CAROL)["amount"] == ents[CAROL]
    assert ents[CAROL] == 4 * SECOND + (4 * SECOND * 8 * SECOND) // (4 * SECOND)
    # doubters lose everything on FULFILLED
    assert c.get_entitlement(vid, ALICE)["present"] is False

    # claims are pull-based and once-only
    assert c.claim(vid) == 10 * SECOND
    v = c.get_vow(vid)
    assert c.get_entitlement(vid, v["proposer"])["claimed"] is True
    with vm.expect_revert("ALREADY_CLAIMED"):
        c.claim(vid)
    with vm.prank(CAROL):
        assert c.claim(vid) == 4 * SECOND + (4 * SECOND * 8 * SECOND) // (4 * SECOND)
    inv = c.get_invariant()
    assert inv["consistent"] is True


def test_broken_settlement_burns_half_and_pays_doubt(clarity):
    c, vm = clarity
    vid = _pass_deadline(c, vm, backs=(
        (ALICE, SIDE_DOUBT, 5 * SECOND),
        (BOB, SIDE_FAITH, 3 * SECOND),
    ))
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-20"))
    assert c.assess(vid) == M.VERDICT_BROKEN
    _past_window(vm)
    c.finalize(vid)
    st = c.get_settlement(vid)
    assert st["verdict"] == M.VERDICT_BROKEN
    assert st["burned"] == 5 * SECOND            # half of the founder stake
    assert st["to_doubt"] == (5 + 3) * SECOND    # other half + faith forfeit

    ents, burned = M.entitlements_for({ALICE: (SIDE_DOUBT, 5 * SECOND),
                                       BOB: (SIDE_FAITH, 3 * SECOND)},
                                      10 * SECOND, M.VERDICT_BROKEN)
    assert burned == 5 * SECOND
    ent = c.get_entitlement(vid, ALICE)
    assert ent["amount"] == ents[ALICE]
    assert ent["amount"] == 5 * SECOND + (5 * SECOND * 8 * SECOND) // (5 * SECOND)
    # the faithful lose everything on BROKEN
    assert c.get_entitlement(vid, BOB)["present"] is False
    with vm.prank(ALICE):
        assert c.claim(vid) == ents[ALICE]
    inv = c.get_invariant()
    assert inv["consistent"] is True
    assert inv["burned_total"] == 5 * SECOND


def test_broken_with_no_backers_burns_half_stake(clarity):
    c, vm = clarity
    # No backers at all: the faith cap makes faithless-vow backings impossible
    # without doubt present, so with zero doubt the only money is the stake.
    vid = _pass_deadline(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-20"))
    c.assess(vid)
    _past_window(vm)
    c.finalize(vid)
    st = c.get_settlement(vid)
    assert st["burned"] == 10 * SECOND     # no doubters: the whole stake burns
    assert st["to_doubt"] == 0 and st["to_faith"] == 0
    # nothing is claimable and nothing is stranded
    assert c.get_stats()["burned_total"] == 10 * SECOND
    inv = c.get_invariant()
    assert inv["consistent"] is True


def test_unclear_refunds_everything(clarity):
    c, vm = clarity
    vid = _pass_deadline(c, vm, backs=(
        (ALICE, SIDE_DOUBT, 4 * SECOND),
        (BOB, SIDE_FAITH, 4 * SECOND),
    ))
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("UNCLEAR", "", ""))
    c.assess(vid)
    _past_window(vm)
    c.finalize(vid)
    st = c.get_settlement(vid)
    assert st["burned"] == 0 and st["to_proposer"] == 10 * SECOND
    assert c.get_entitlement(vid, ALICE)["amount"] == 4 * SECOND
    assert c.get_entitlement(vid, BOB)["amount"] == 4 * SECOND
    with vm.prank(ALICE):
        assert c.claim(vid) == 4 * SECOND
    with vm.prank(BOB):
        assert c.claim(vid) == 4 * SECOND
    assert c.claim(vid) == 10 * SECOND       # founder refund
    inv = c.get_invariant()
    assert inv["consistent"] is True
    assert inv["dispatched"] == 18 * SECOND
    assert inv["burned_total"] == 0


def test_settlement_preview_matches_final(clarity):
    c, vm = clarity
    vid = _pass_deadline(c, vm, backs=((ALICE, SIDE_DOUBT, 5 * SECOND),))
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-20"))
    c.assess(vid)
    pre = c.get_settlement_preview(vid)
    _past_window(vm)
    c.finalize(vid)
    post = c.get_settlement(vid)
    assert pre["verdict"] == post["verdict"] == M.VERDICT_BROKEN
    assert pre["burned"] == post["burned"]
    assert pre["to_doubt"] == post["to_doubt"]
    assert pre["to_proposer"] == post["to_proposer"]


def test_finalize_unassessed_after_grace_is_unclear(clarity):
    c, vm = clarity
    vid = _pass_deadline(c, vm)
    with vm.expect_revert("GRACE_NOT_PASSED"):
        c.finalize(vid)
    vm.warp("2026-06-06T00:00:00Z")     # 4 days after the deadline
    c.finalize(vid)
    v = c.get_vow(vid)
    assert v["state"] == M.STATE_SETTLED
    st = c.get_settlement(vid)
    assert st["verdict"] == M.VERDICT_UNCLEAR
    assert st["reason"] == "UNASSESSED"
    ev = c.get_evidence(vid)
    assert ev["quote"] == "" and ev["tier"] == 0
    # full refund semantics
    assert c.claim(vid) == 10 * SECOND
    inv = c.get_invariant()
    assert inv["consistent"] is True


def test_claim_before_finalize_fails(clarity):
    c, vm = clarity
    vid = _pass_deadline(c, vm)
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("BROKEN", FAIL_QUOTE, "2026-05-20"))
    c.assess(vid)
    with vm.expect_revert("NOT_SETTLED"):
        c.claim(vid)


def test_no_value_is_stranded_on_odd_split(clarity):
    """Shares that do not divide evenly leave an explicit remainder burn."""
    c, vm = clarity
    # faith totals 3 (1+2); the doubter pool is 5.
    # shares: (1*5)//3 = 1 and (2*5)//3 = 3 -> sum 4, remainder 1 GEN burned.
    vid = _pass_deadline(c, vm, backs=(
        (ALICE, SIDE_DOUBT, 2 * SECOND),
        (BOB, SIDE_DOUBT, 3 * SECOND),
        (CAROL, SIDE_FAITH, 1 * SECOND),
        (DAVE, SIDE_FAITH, 2 * SECOND),
    ))
    vm.mock_llm(r"EVIDENCE-BEGIN", llm_full("FULFILLED", SUCCESS_QUOTE, "2026-05-20"))
    c.assess(vid)
    _past_window(vm)
    c.finalize(vid)
    st = c.get_settlement(vid)
    ents, burned = M.entitlements_for({
        CAROL: (SIDE_FAITH, 1 * SECOND),
        DAVE: (SIDE_FAITH, 2 * SECOND),
        ALICE: (SIDE_DOUBT, 2 * SECOND),
        BOB: (SIDE_DOUBT, 3 * SECOND),
    }, 10 * SECOND, M.VERDICT_FULFILLED)
    assert st["burned"] == burned and burned == 1    # 1 wei remainder burn
    assert st["to_faith"] == 5 * SECOND
    assert c.get_entitlement(vid, CAROL)["amount"] == ents[CAROL]
    assert c.get_entitlement(vid, DAVE)["amount"] == ents[DAVE]
    # with vm.prank(CAROL):
    with vm.prank(CAROL):
        assert c.claim(vid) == ents[CAROL]
    inv = c.get_invariant()
    assert inv["consistent"] is True
    assert inv["burned_total"] == 1    # one wei of dust burned, by design
