"""Independent mirror of the contract's deterministic rules.

The tests compute expected outcomes with THIS module and compare them with the
contract's own outputs — a second, independent implementation of every
deterministic rule, which is what turns the suite into protocol verification
rather than a change-detector.
"""

from datetime import datetime, timedelta, timezone

MIN_VOW_STAKE = 10 * 10 ** 18
MIN_BACKING = 1 * 10 ** 18
MAX_PARTICIPANTS = 64
MAX_VOW_TEXT = 2000
MAX_EVIDENCE_URL = 400
MIN_QUOTE_LEN = 48

VERDICT_FULFILLED = 1
VERDICT_BROKEN = 2
VERDICT_UNCLEAR = 3
STATE_OPEN = 1
STATE_PROVISIONAL = 2
STATE_SETTLED = 3
STATE_CANCELLED = 4
TIER_SNAPSHOT, TIER_PERMALINK, TIER_MUTABLE = 1, 2, 3

DISPUTE_WINDOW = 900
FINALIZE_GRACE = 3 * 24 * 3600


def canon_ts(s: str) -> str:
    t = s.strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    dt = datetime.fromisoformat(t)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def ts_plus(canonical: str, seconds: int) -> str:
    t = canon_ts(canonical)
    dt = datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return (dt + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def settle_math(stake: int, faith_total: int, doubt_total: int, verdict: int):
    P, F, D = stake, faith_total, doubt_total
    if verdict == VERDICT_FULFILLED:
        if D > 0 and F > 0:
            return {"burned": 0, "to_proposer": P, "to_faith": D, "to_doubt": 0}
        if D > 0 and F == 0:
            return {"burned": D, "to_proposer": P, "to_faith": 0, "to_doubt": 0}
        return {"burned": 0, "to_proposer": P, "to_faith": 0, "to_doubt": 0}
    if verdict == VERDICT_BROKEN:
        burn_p = P // 2
        if D == 0:
            return {"burned": P + F, "to_proposer": 0, "to_faith": 0,
                    "to_doubt": 0}
        return {"burned": burn_p, "to_proposer": 0, "to_faith": 0,
                "to_doubt": (P - burn_p) + F}
    return {"burned": 0, "to_proposer": P, "to_faith": 0, "to_doubt": 0}


def entitlements_for(backings: dict, stake: int, verdict: int, proposer: str = "PROPOSER"):
    """Mirror of the entitlement construction.

    backings: {addr_hex: (side_int, amount_int)} where side 1=FAITH 2=DOUBT
    Returns (entitlements {addr_or_"PROPOSER": amount}, burned_total).
    """
    F = sum(a for s, a in backings.values() if s == 1)
    D = sum(a for s, a in backings.values() if s == 2)
    math = settle_math(stake, F, D, verdict)
    ents = {}
    remaining_burn = 0
    if math["to_proposer"] > 0:
        ents[proposer] = math["to_proposer"]
    if verdict == VERDICT_FULFILLED and math["to_faith"] > 0:
        pool = math["to_faith"]
        distributed = 0
        for addr, (side, amt) in backings.items():
            if side == 1:
                sh = (amt * pool) // F
                ents[addr] = amt + sh
                distributed += sh
        remaining_burn = pool - distributed
    elif verdict == VERDICT_BROKEN and math["to_doubt"] > 0:
        pool = math["to_doubt"]
        distributed = 0
        for addr, (side, amt) in backings.items():
            if side == 2:
                sh = (amt * pool) // D
                ents[addr] = amt + sh
                distributed += sh
        remaining_burn = pool - distributed
    elif verdict == VERDICT_UNCLEAR:
        for addr, (side, amt) in backings.items():
            ents[addr] = amt
    return ents, math["burned"] + remaining_burn
