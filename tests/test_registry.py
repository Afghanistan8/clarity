"""Vow registry: creation rules, URL/text validation, backing rules, cancel."""

from conftest import (
    PERM_URL, T, SECOND, default_mocks,
)
import pytest
import mirror


def test_constants_are_self_describing(clarity):
    c, vm = clarity
    k = c.get_constants()
    assert k["min_vow_stake"] == mirror.MIN_VOW_STAKE
    assert k["min_backing"] == mirror.MIN_BACKING
    assert k["dispute_window_sec"] == mirror.DISPUTE_WINDOW
    assert k["max_participants"] == mirror.MAX_PARTICIPANTS
    assert k["min_quote_len"] == mirror.MIN_QUOTE_LEN


def test_create_vow_happy_path(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    vid = c.create_vow("I will finish the well", "2026-06-05T00:00:00Z", PERM_URL)
    assert vid == 1
    v = c.get_vow(1)
    assert v["state"] == mirror.STATE_OPEN
    assert v["stake"] == 10 * SECOND
    assert v["deadline"] == "2026-06-05T00:00:00Z"
    assert v["evidence_url"] == PERM_URL
    assert v["evidence_set"] is True
    assert v["faith_total"] == 0 and v["doubt_total"] == 0
    import hashlib
    assert v["text_sha256"] == hashlib.sha256(b"I will finish the well").hexdigest()
    log = c.get_log(10)
    assert log[-1]["code"] == "VOW_CREATED"
    stats = c.get_stats()
    assert stats["vow_count"] == 1
    assert stats["escrow"] == 10 * SECOND


@pytest.mark.parametrize("text", ["", "   ", "x" * (mirror.MAX_VOW_TEXT + 1)])
def test_create_vow_rejects_bad_text(clarity, text):
    c, vm = clarity
    vm.value = 10 * SECOND
    with vm.expect_revert("CLARITY:"):
        c.create_vow(text, "2026-06-05T00:00:00Z", PERM_URL)


def test_create_vow_rejects_bad_url(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    deadline = "2026-06-05T00:00:00Z"
    bad_urls = [
        "http://proof.example/log",                # wrong scheme
        "https://proof.example/log#frag",          # fragment
        "https://user@proof.example/log",          # userinfo
        "https://proof.example/log with space",    # whitespace
        "https://proofexample",                    # no TLD
        "https://proof.example:99999/log",         # bad port
        "https://.proof.example/log",              # leading dot
        "https://proof.example/log?x=\x01",        # control char
        "",                                        # empty
        "https://" + "a" * 500,                    # too long
    ]
    for u in bad_urls:
        with vm.expect_revert("CLARITY:"):
            c.create_vow("valid text", deadline, u)


def test_create_vow_rejects_bad_deadlines(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    with vm.expect_revert("DEADLINE_TOO_SOON"):
        c.create_vow("v", "2026-06-01T12:00:00Z", PERM_URL)  # == now, too soon
    with vm.expect_revert("DEADLINE_TOO_SOON"):
        c.create_vow("v", "2026-06-01T12:00:04Z", PERM_URL)  # < lead
    with vm.expect_revert("DEADLINE_TOO_FAR"):
        c.create_vow("v", "2028-06-05T00:00:00Z", PERM_URL)  # > span
    with vm.expect_revert():
        c.create_vow("v", "garbage", PERM_URL)               # unparseable


def test_create_vow_rejects_low_stake(clarity):
    c, vm = clarity
    vm.value = 9 * SECOND
    with vm.expect_revert("STAKE_TOO_LOW"):
        c.create_vow("v", "2026-06-05T00:00:00Z", PERM_URL)
    vm.value = 10 * SECOND
    vid = c.create_vow("v", "2026-06-05T00:00:00Z", PERM_URL)
    assert vid == 1


def test_set_evidence_rules(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    c.create_vow("v", "2026-06-05T00:00:00Z", PERM_URL)
    with vm.expect_revert("NOT_PROPOSER"):
        with vm.prank("0x1111111111111111111111111111111111111111"):
            c.set_evidence(1, "https://other.example/page")
    c.set_evidence(1, "https://other.example/page2")
    v = c.get_vow(1)
    assert v["evidence_url"] == "https://other.example/page2"
    # after deadline it is locked
    vm.warp("2026-06-05T00:00:01Z")
    with vm.expect_revert("DEADLINE_PASSED"):
        c.set_evidence(1, "https://other.example/page3")


def test_back_rules_and_faith_cap(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    c.create_vow("v", "2026-06-05T00:00:00Z", PERM_URL)
    alice = "0x1111111111111111111111111111111111111111"
    bob = "0x2222222222222222222222222222222222222222"
    # the faith cap: the first backer cannot be faithful (no doubt exists yet)
    vm.value = 5 * SECOND
    with vm.prank(alice):
        with vm.expect_revert("FAITH_CAP"):
            c.back(1, 1)
    # doubt is always allowed
    with vm.prank(alice):
        c.back(1, 2)
    v = c.get_vow(1)
    assert v["doubt_total"] == 5 * SECOND and v["doubt_n"] == 1
    # faith may now equal doubt but not exceed it
    vm.value = 6 * SECOND
    with vm.prank(bob):
        with vm.expect_revert("FAITH_CAP"):
            c.back(1, 1)
    vm.value = 5 * SECOND
    with vm.prank(bob):
        c.back(1, 1)
    v = c.get_vow(1)
    assert v["faith_total"] == 5 * SECOND and v["faith_n"] == 1
    backs = c.get_backings(1)
    assert len(backs) == 2
    # one side per address (regardless of which side)
    with vm.prank(alice):
        vm.value = 1 * SECOND
        with vm.expect_revert("ALREADY_BACKED"):
            c.back(1, 2)
    with vm.prank(bob):
        vm.value = 1 * SECOND
        with vm.expect_revert("ALREADY_BACKED"):
            c.back(1, 2)
    # founder cannot back
    vm.value = 1 * SECOND
    with vm.expect_revert("FOUNDER_CANNOT_BACK"):
        c.back(1, 2)
    # bad side
    carol = "0x3333333333333333333333333333333333333333"
    with vm.prank(carol):
        with vm.expect_revert("BAD_SIDE"):
            c.back(1, 7)
    # stakes below the minimum are refused
    with vm.prank(carol):
        vm.value = 1
        with vm.expect_revert("BACKING_TOO_SMALL"):
            c.back(1, 2)
    # backing is refused after the deadline
    vm.warp("2026-06-05T00:00:01Z")
    vm.value = 2 * SECOND
    with vm.prank(carol):
        with vm.expect_revert("DEADLINE_PASSED"):
            c.back(1, 2)


def test_back_rejects_bad_vow(clarity):
    c, vm = clarity
    vm.value = 1 * SECOND
    with vm.expect_revert("CLARITY:NOT_FOUND"):
        c.back(99, 2)


def test_escrow_accounting(clarity):
    c, vm = clarity
    vm.value = 12 * SECOND
    c.create_vow("v1", "2026-06-05T00:00:00Z", PERM_URL)
    vm.value = 3 * SECOND
    with vm.prank("0x1111111111111111111111111111111111111111"):
        c.back(1, 2)
    stats = c.get_stats()
    assert stats["escrow"] == 15 * SECOND
    inv = c.get_invariant()
    assert inv["consistent"] is True


def test_early_cancel_refunds_everyone(clarity):
    c, vm = clarity
    vm.value = 10 * SECOND
    c.create_vow("v", "2026-06-05T00:00:00Z", PERM_URL)
    vm.value = 4 * SECOND
    with vm.prank("0x2222222222222222222222222222222222222222"):
        c.back(1, 2)
    vm.value = 3 * SECOND
    with vm.prank("0x1111111111111111111111111111111111111111"):
        c.back(1, 1)
    # only the founder may cancel
    with vm.prank("0x1111111111111111111111111111111111111111"):
        with vm.expect_revert("NOT_PROPOSER"):
            c.early_cancel(1)
    c.early_cancel(1)
    v = c.get_vow(1)
    assert v["state"] == mirror.STATE_CANCELLED
    st = c.get_settlement(1)
    assert st["reason"] == "EARLY_CANCEL"
    stats = c.get_stats()
    assert stats["dispatched"] == 17 * SECOND          # 10 stake + 4 + 3 backs
    assert stats["outstanding"] == 0
    inv = c.get_invariant()
    assert inv["consistent"] is True
    # double-cancel fails
    with vm.expect_revert("NOT_OPEN"):
        c.early_cancel(1)


def test_get_vow_summaries(clarity):
    c, vm = clarity
    assert c.get_vow_summaries(5) == []
    vm.value = 10 * SECOND
    c.create_vow("first vow", "2026-06-05T00:00:00Z", PERM_URL)
    c.create_vow("second vow", "2026-06-06T00:00:00Z", PERM_URL)
    s = c.get_vow_summaries(5)
    assert len(s) == 2
    assert s[0]["id"] == 2 and s[1]["id"] == 1      # newest first
    assert s[0]["text_head"] == "second vow"
    assert s[0]["state"] == mirror.STATE_OPEN
