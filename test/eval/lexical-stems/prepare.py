"""Build the lexical-stems battery's corpus from MIRACL (Apache 2.0) as
published for MTEB reranking (huggingface.co/datasets/mteb/MIRACLReranking).

Per language: N dev queries (default 50, the README run) that have a relevant passage (seeded sample),
their human relevance judgements, and every candidate passage MTEB lists
for them, pooled. Needs pyarrow. Usage:

    python prepare.py <dir with {lang}-{corpus,queries,qrels,top_ranked}.parquet> <out dir> [queries=50]
"""
import ast
import json
import random
import sys

import pyarrow.parquet as pq

LANGS = 'ru es fr de en zh ja ko ar hi'.split()
QUERIES = int(sys.argv[3]) if len(sys.argv) > 3 else 50

src, out = sys.argv[1:3]
for lang in LANGS:
    queries = pq.read_table(f'{src}/{lang}-queries.parquet').to_pylist()
    relevant = {}
    for r in pq.read_table(f'{src}/{lang}-qrels.parquet').to_pylist():
        if int(r['score']) > 0:
            relevant.setdefault(r['query-id'], []).append(r['corpus-id'])
    queries = [q for q in queries if q['_id'] in relevant]
    random.Random(0).shuffle(queries)
    queries = queries[:QUERIES]
    keep = {q['_id'] for q in queries}
    pool = set()
    for r in pq.read_table(f'{src}/{lang}-top_ranked.parquet').to_pylist():
        if r['query-id'] in keep:
            ids = r['corpus-ids']
            pool.update(ast.literal_eval(ids) if isinstance(ids, str) else ids)
    corpus = [
        {'id': c['_id'], 'text': ((c['title'] or '') + ' ' + c['text']).strip()}
        for c in pq.read_table(f'{src}/{lang}-corpus.parquet').to_pylist()
        if c['_id'] in pool
    ]
    with open(f'{out}/{lang}.json', 'w') as f:
        json.dump(
            {
                'lang': lang,
                'queries': [
                    {'id': q['_id'], 'text': q['text'], 'relevant': relevant[q['_id']]}
                    for q in queries
                ],
                'corpus': corpus,
            },
            f,
            ensure_ascii=False,
        )
    print(lang, len(queries), len(corpus))
