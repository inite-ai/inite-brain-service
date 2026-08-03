#!/usr/bin/env python3
"""Paired McNemar comparison of two LoCoMo reports (base vs leg).

LoCoMo score rows carry no questionId — pairing key is
(sampleId, category, question), the same content-addressed key the
runner's checkpoint uses. The headline pairs answerable categories
(1-4) on judgeCorrect, exactly the report's own denominator;
adversarial (cat 5) is paired on the abstention convention and
reported separately, never mixed into the headline.
"""
import json
import sys
from math import comb
from collections import defaultdict

ADVERSARIAL = 5


def key(s):
    return (s["sampleId"], s["category"], s["question"])


def load(path):
    d = json.load(open(path))
    return d, {key(s): s for s in d["scores"]}


def mcnemar_p(b, c):
    n = b + c
    if n == 0:
        return 1.0
    m = min(b, c)
    p = 2 * sum(comb(n, k) for k in range(0, m + 1)) / 2**n
    return min(1.0, p)


def paired_block(rows, correct_fn, label):
    both = wins_leg = wins_base = neither = 0
    for sb, sl in rows:
        cb, cl = correct_fn(sb), correct_fn(sl)
        if cb and cl:
            both += 1
        elif cl:
            wins_leg += 1
        elif cb:
            wins_base += 1
        else:
            neither += 1
    n = both + wins_leg + wins_base + neither
    if n == 0:
        print(f"{label}: no paired rows")
        return
    acc_b = (both + wins_base) / n
    acc_l = (both + wins_leg) / n
    p = mcnemar_p(wins_base, wins_leg)
    print(
        f"{label}: n={n} base={100 * acc_b:.1f}% leg={100 * acc_l:.1f}% "
        f"delta={100 * (acc_l - acc_b):+.1f}pp "
        f"flips base->leg wins={wins_leg} losses={wins_base} p={p:.4g}"
    )


def main():
    base_path, leg_path = sys.argv[1], sys.argv[2]
    db, mb = load(base_path)
    dl, ml = load(leg_path)
    common = sorted(set(mb) & set(ml))
    print(
        f"base={base_path} rows={len(mb)}  leg={leg_path} rows={len(ml)}  "
        f"paired={len(common)}"
    )
    unpaired = (len(mb) - len(common)) + (len(ml) - len(common))
    if unpaired:
        print(f"WARNING: {unpaired} unpaired rows — check dataset slice/split")

    answerable = [
        (mb[k], ml[k])
        for k in common
        if mb[k]["category"] != ADVERSARIAL
        and mb[k].get("judgeCorrect") is not None
        and ml[k].get("judgeCorrect") is not None
    ]
    paired_block(answerable, lambda s: bool(s["judgeCorrect"]), "headline (cat1-4, judge)")

    by_cat = defaultdict(list)
    for sb, sl in answerable:
        by_cat[sb["category"]].append((sb, sl))
    for cat in sorted(by_cat):
        paired_block(by_cat[cat], lambda s: bool(s["judgeCorrect"]), f"  cat{cat}")

    adversarial = [
        (mb[k], ml[k]) for k in common if mb[k]["category"] == ADVERSARIAL
    ]
    paired_block(adversarial, lambda s: bool(s.get("abstained")), "adversarial (abstain)")


if __name__ == "__main__":
    main()
