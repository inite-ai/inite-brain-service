#!/usr/bin/env python3
"""Download + normalize a BEAM split to JSON for the TS harness.

BEAM (ICLR 2026, arXiv 2510.27246): 100 conversations / 2000 validated
questions across ten memory abilities, in token tiers 100K/500K/1M (this
HF dataset) plus a separately-shaped 10M tier (BEAM-10M, not handled
here). Source: https://huggingface.co/datasets/Mohammadta/BEAM

The parquet rows carry the probing questions as a Python-literal string
and gold answers under an ability-specific key; this script flattens both
quirks so the TS loader stays uniform:

  python3 scripts/fetch-beam-dataset.py --split 100K --out /tmp/beam_100k.json

Requires: python3 + pyarrow (no HF client — plain HTTPS download).
"""
import argparse
import ast
import datetime as dt
import json
import os
import sys
import urllib.request

HF_BASE = "https://huggingface.co/datasets/Mohammadta/BEAM/resolve/main/data"
SPLIT_FILES = {
    "100K": "100K-00000-of-00001.parquet",
    "500K": "500K-00000-of-00001.parquet",
    "1M": "1M-00000-of-00001.parquet",
}

# Gold answer lives under a different key per ability.
GOLD_KEY = {
    "abstention": "ideal_response",
    "contradiction_resolution": "ideal_answer",
    "event_ordering": "answer",
    "information_extraction": "answer",
    "instruction_following": "expected_compliance",
    "knowledge_update": "answer",
    "multi_session_reasoning": "answer",
    "preference_following": "expected_compliance",
    "summarization": "ideal_summary",
    "temporal_reasoning": "answer",
}

MONTHS = {
    m: i + 1
    for i, m in enumerate(
        [
            "january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december",
        ]
    )
}


def parse_anchor(raw):
    """'March-15-2024' -> date, else None."""
    if not raw or raw == "None":
        return None
    parts = raw.replace("_", "-").split("-")
    if len(parts) != 3:
        return None
    month = MONTHS.get(parts[0].strip().lower())
    try:
        return dt.date(int(parts[2]), month, int(parts[1])) if month else None
    except ValueError:
        return None


def session_dates(sessions):
    """First parseable anchor per session; gaps carry forward +14 days."""
    dates, prev = [], None
    for turns in sessions:
        found = None
        for t in turns:
            found = parse_anchor(t.get("time_anchor"))
            if found:
                break
        if not found:
            found = (prev + dt.timedelta(days=14)) if prev else dt.date(2024, 1, 15)
        dates.append(found)
        prev = found
    return dates


def as_rubric(value):
    if isinstance(value, list):
        return [str(v) for v in value if str(v).strip()]
    return [str(value)] if value else []


def normalize(rows, split):
    out = []
    for row in rows:
        sessions_raw = row["chat"]
        dates = session_dates(sessions_raw)
        sessions = []
        for si, turns in enumerate(sessions_raw):
            sessions.append(
                {
                    "sessionId": f"{row['conversation_id']}:{si}",
                    "dateIso": f"{dates[si].isoformat()}T09:00:00.000Z",
                    "turns": [
                        {"role": t["role"], "content": t["content"]}
                        for t in turns
                        if isinstance(t.get("content"), str) and t["content"].strip()
                    ],
                }
            )
        probing = ast.literal_eval(row["probing_questions"])
        questions = []
        for ability, qs in probing.items():
            gold_key = GOLD_KEY.get(ability)
            for qi, q in enumerate(qs):
                rubric = as_rubric(q.get("rubric"))
                # Compliance indicators are the de-facto rubric for the
                # two "following" abilities — fold them in for the judge.
                rubric += as_rubric(q.get("compliance_indicators"))
                questions.append(
                    {
                        "questionId": f"{row['conversation_id']}:{ability}:{qi}",
                        "ability": ability,
                        "question": q["question"],
                        "gold": str(q.get(gold_key) or ""),
                        "difficulty": q.get("difficulty", ""),
                        "rubric": rubric,
                        "sourceChatIds": q.get("source_chat_ids") or [],
                    }
                )
        seed = row.get("conversation_seed") or {}
        out.append(
            {
                "conversationId": str(row["conversation_id"]),
                "split": split,
                "category": seed.get("category", ""),
                "title": seed.get("title", ""),
                "sessions": sessions,
                "questions": questions,
            }
        )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=sorted(SPLIT_FILES), default="100K")
    ap.add_argument("--out", required=True)
    ap.add_argument(
        "--parquet",
        help="Reuse an already-downloaded parquet instead of fetching",
    )
    args = ap.parse_args()

    parquet = args.parquet or f"/tmp/beam_{args.split.lower()}.parquet"
    if not os.path.exists(parquet):
        url = f"{HF_BASE}/{SPLIT_FILES[args.split]}"
        print(f"downloading {url}", file=sys.stderr)
        urllib.request.urlretrieve(url, parquet)

    import pyarrow.parquet as pq

    rows = pq.read_table(parquet).to_pylist()
    data = normalize(rows, args.split)
    with open(args.out, "w") as f:
        json.dump(data, f)
    n_q = sum(len(c["questions"]) for c in data)
    chars = sum(
        len(t["content"]) for c in data for s in c["sessions"] for t in s["turns"]
    )
    print(
        f"[beam] split={args.split} conversations={len(data)} questions={n_q} "
        f"~haystack-tokens={chars // 4:,} -> {args.out}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
