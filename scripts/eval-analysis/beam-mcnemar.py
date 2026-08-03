#!/usr/bin/env python3
"""Paired McNemar comparison of two BEAM reports (base vs leg)."""
import json
import sys
from math import comb
from collections import defaultdict


def correct(s):
    jc = s.get("judgeCorrect")
    if jc is not None:
        return bool(jc)
    # abstention rows: correct when abstain behavior matches expectation
    return bool(s.get("abstained")) == bool(s.get("isAbstention"))


def load(path):
    d = json.load(open(path))
    return d, {s["questionId"]: s for s in d["scores"]}


def mcnemar_p(b, c):
    n = b + c
    if n == 0:
        return 1.0
    m = min(b, c)
    p = 2 * sum(comb(n, k) for k in range(0, m + 1)) / 2 ** n
    return min(1.0, p)


def main():
    base_path, leg_path = sys.argv[1], sys.argv[2]
    db, mb = load(base_path)
    dl, ml = load(leg_path)
    common = sorted(set(mb) & set(ml))
    print(f"base={base_path} n={db['n']}  leg={leg_path} n={dl['n']}  paired={len(common)}")
    only_b = len(mb) - len(common)
    only_l = len(ml) - len(common)
    if only_b or only_l:
        print(f"WARNING: unpaired rows base={only_b} leg={only_l}")

    groups = defaultdict(list)
    for q in common:
        groups[mb[q]["group"]].append(q)

    def stats(qs):
        b = sum(1 for q in qs if correct(mb[q]) and not correct(ml[q]))
        c = sum(1 for q in qs if not correct(mb[q]) and correct(ml[q]))
        accb = sum(correct(mb[q]) for q in qs) / len(qs)
        accl = sum(correct(ml[q]) for q in qs) / len(qs)
        return accb, accl, b, c, mcnemar_p(b, c)

    print(f"{'ability':<28}{'n':>4}{'base':>8}{'leg':>8}{'delta':>8}{'b->':>5}{'c<-':>5}{'p':>9}")
    for g in sorted(groups):
        qs = groups[g]
        accb, accl, b, c, p = stats(qs)
        print(f"{g:<28}{len(qs):>4}{accb:>8.3f}{accl:>8.3f}{accl-accb:>+8.3f}{b:>5}{c:>5}{p:>9.4f}")
    accb, accl, b, c, p = stats(common)
    print(f"{'OVERALL':<28}{len(common):>4}{accb:>8.3f}{accl:>8.3f}{accl-accb:>+8.3f}{b:>5}{c:>5}{p:>9.4f}")

    # judged-only overall (excludes abstention rows), comparable to judgeAccuracy
    judged = [q for q in common if mb[q].get("judgeCorrect") is not None and ml[q].get("judgeCorrect") is not None]
    if judged:
        accb, accl, b, c, p = stats(judged)
        print(f"{'JUDGED-ONLY':<28}{len(judged):>4}{accb:>8.3f}{accl:>8.3f}{accl-accb:>+8.3f}{b:>5}{c:>5}{p:>9.4f}")


if __name__ == "__main__":
    main()
