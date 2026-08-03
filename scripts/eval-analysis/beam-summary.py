#!/usr/bin/env python3
"""Print a one-screen summary of a BEAM report."""
import json
import sys

d = json.load(open(sys.argv[1]))
print(f"n={d['n']} judgeAccuracy={d['judgeAccuracy']:.4f} judgedN={d['judgedN']} "
      f"avgPromptTokens={d.get('avgPromptTokens')} errored={d.get('errored')}")
ab = d.get("abstention")
if ab:
    print(f"abstention: n={ab['n']} abstainedRate={ab['abstainedRate']}")
for row in d["byAbility"]:
    print(f"  {row['ability']:<28}{row['n']:>4}  {row['judgeAccuracy']:.4f}")
