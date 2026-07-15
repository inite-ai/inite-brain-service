/**
 * Reference external indexer — the smallest honest implementation of
 * docs/indexer-protocol.md. Dependency-free (global fetch, Node 18+).
 *
 *   BRAIN_URL=http://localhost:3000 \
 *   BRAIN_API_KEY=<key with indexer:write> \
 *   PACK_ID=code_memory \
 *   pnpm indexer:reference
 *
 * Loop: poll work → claim → read content → "extract" (a deliberately
 * trivial regex that quotes verbatim sentences — a real indexer puts its
 * domain model here) → submit with the claim → repeat. Runs one pass and
 * exits; wrap it in your own scheduler for continuous operation.
 */

const BRAIN_URL = process.env.BRAIN_URL ?? 'http://localhost:3000';
const API_KEY = process.env.BRAIN_API_KEY ?? '';
const PACK_ID = process.env.PACK_ID ?? 'code_memory';
const LIMIT = Number(process.env.WORK_LIMIT ?? 10);

interface WorkItem {
  runId: string;
  documentId: string;
  packId: string;
  packVersion: string;
  docHasContent: boolean;
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BRAIN_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * The "extractor": finds sentences that look like recorded decisions and
 * quotes them verbatim (grounding requires verbatim spans — see
 * docs/indexer-protocol.md "Grounding rules"). Replace this function
 * with your actual domain extraction.
 */
function extract(text: string): {
  entities: Array<{ name: string; type?: string }>;
  facts: Array<{
    entityIndex: number;
    predicate: string;
    object: string;
    confidence: number;
    clause?: string;
  }>;
} {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const decision = sentences.find((s) => /\b(decided|decision|chosen)\b/i.test(s));
  if (!decision) return { entities: [], facts: [] };

  // Subject: the first path-like or Capitalized token in the sentence —
  // it appears verbatim in the text, so it grounds as an entity name.
  const subject =
    decision.match(/[\w./-]+\.[a-z]{1,4}\b/)?.[0] ??
    decision.match(/\b[A-Z][\w-]{2,}\b/)?.[0];
  if (!subject) return { entities: [], facts: [] };

  // Object: a verbatim tail of the decision sentence (strip the final
  // period — punctuation survives normalization, but keep it simple).
  const object = decision.replace(/[.!?]$/, '');
  return {
    entities: [{ name: subject, type: 'asset' }],
    facts: [
      {
        entityIndex: 0,
        predicate: `${PACK_ID}__decided`,
        object,
        confidence: 0.8,
        clause: decision,
      },
    ],
  };
}

async function processItem(item: WorkItem): Promise<void> {
  const claim = await api('POST', `/v1/indexer/work/${item.runId}/claim`, {});
  if (claim.status !== 201 && claim.status !== 200) {
    console.log(`  claim lost (${claim.status}) — another replica has it`);
    return;
  }
  const { claimToken } = claim.json;

  if (!item.docHasContent) {
    // No stored text to read; we have no out-of-band copy → permanent.
    await api('POST', `/v1/indexer/work/${item.runId}/fail`, {
      claimToken,
      error: 'no stored content and no out-of-band copy',
      permanent: true,
    });
    console.log('  no content — permanently failed the slot');
    return;
  }

  const content = await api('GET', `/v1/indexer/work/${item.runId}/content`);
  if (content.status !== 200) {
    await api('POST', `/v1/indexer/work/${item.runId}/fail`, {
      claimToken,
      error: `content fetch failed: ${content.status}`,
    });
    return;
  }
  const text = content.json.chunks
    .map((c: { text: string }) => c.text)
    .join('\n');

  const batch = extract(text);
  if (batch.facts.length === 0) {
    // Nothing our domain recognizes — a permanent skip is the honest
    // verdict (release would just re-offer it to us forever).
    await api('POST', `/v1/indexer/work/${item.runId}/fail`, {
      claimToken,
      error: 'no decision-like sentences found',
      permanent: true,
    });
    console.log('  nothing to extract — permanently failed the slot');
    return;
  }

  const submit = await api(
    'POST',
    `/v1/documents/${item.documentId}/candidates`,
    {
      indexerId: PACK_ID,
      runId: item.runId,
      claimToken,
      entities: batch.entities,
      facts: batch.facts,
    },
  );
  if (submit.status === 201 || submit.status === 200) {
    const { staged, dropped } = submit.json;
    console.log(
      `  staged entities=${staged.entities} facts=${staged.facts}` +
        (dropped.length ? ` dropped=${dropped.length}` : ''),
    );
  } else {
    console.log(`  submit failed (${submit.status}):`, submit.json?.message);
    await api('POST', `/v1/indexer/work/${item.runId}/fail`, {
      claimToken,
      error: `submit failed: ${submit.status}`,
    });
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error('BRAIN_API_KEY is required (scope indexer:write)');
    process.exit(1);
  }
  const list = await api(
    'GET',
    `/v1/indexer/work?packId=${encodeURIComponent(PACK_ID)}&limit=${LIMIT}`,
  );
  if (list.status !== 200) {
    console.error(`poll failed (${list.status}):`, list.json?.message);
    process.exit(1);
  }
  const work: WorkItem[] = list.json.work;
  console.log(`${work.length} work item(s) for pack ${PACK_ID}`);
  for (const item of work) {
    console.log(`- ${item.runId} → ${item.documentId}`);
    await processItem(item);
  }
}

void main();
