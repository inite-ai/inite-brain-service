import { createBrain } from '@inite/brain';

// 1. Read configuration from environment
const baseUrl = process.env.BRAIN_URL || 'http://localhost:3000';
const apiKey = process.env.BRAIN_KEY;
const userId = process.env.BRAIN_USER_ID || 'quickstart-demo-user';

if (!apiKey) {
  console.error('Error: BRAIN_KEY environment variable is required.');
  console.error(
    'Usage: BRAIN_KEY=<key> [BRAIN_URL=http://localhost:3000] [BRAIN_USER_ID=quickstart-demo-user] npm start',
  );
  process.exit(1);
}

// 2. Initialize Brain SDK client
// Note: Pass the same userId for writes and reads so queries find scoped memories.
const brain = createBrain({
  apiKey,
  baseUrl,
  userId,
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // Configuration comes from the environment and is not echoed: the same
  // environment holds the key.
  console.log('🧠 INITE Brain TypeScript SDK Quickstart\n');

  // Step 1: Remember facts about a made-up person
  console.log('--- Step 1: Remember ---');
  const story =
    'Maria Vance moved to Berlin in June 2026. She works as a distributed systems architect and prefers morning syncs.';
  console.log(`Input text:\n"${story}"\n`);

  const rememberResult = await brain.remember(story);
  console.log('Remember result:', JSON.stringify(rememberResult, null, 2));

  // The write returns at receipt (`pending: true`); extraction runs in the
  // background and usually takes tens of seconds. Ask until the memory has it.
  const question = 'Where does Maria Vance live and what does she do?';
  console.log('\nWaiting for background extraction (up to 3 minutes)...');
  let hits = await brain.recall(question);
  for (let waited = 0; hits.length === 0 && waited < 180_000; waited += 5000) {
    await sleep(5000);
    hits = await brain.recall(question);
  }

  // Step 2: Recall facts using hybrid search
  console.log('\n--- Step 2: Recall ---');
  console.log(`Recall query: "${question}"\n`);
  console.log(`Found ${hits.length} recall hit(s):`);
  for (const hit of hits) {
    console.log(
      `- Entity: ${hit.canonicalName} (ID: ${hit.entityId}, Type: ${hit.entityType}, Score: ${hit.score.toFixed(3)})`,
    );
    for (const fact of hit.facts ?? []) {
      console.log(`    • ${fact.predicate} → ${fact.object} (confidence: ${fact.confidence})`);
    }
  }

  // Step 3: Synthesize an answer with citations
  console.log('\n--- Step 3: Answer with Citations ---');
  console.log(`Question: "${question}"\n`);

  const answerResult = await brain.answer(question);
  console.log(`Answer:\n${answerResult.answer}\n`);
  const citations = answerResult.citations ?? answerResult.evidenceCitations ?? [];
  console.log(`Citations (${citations.length}):`, JSON.stringify(citations, null, 2));

  // Step 4: Inspect entity timeline / bitemporal history
  console.log('\n--- Step 4: Timeline ---');
  const entityId = hits[0]?.entityId;
  if (entityId) {
    console.log(`Fetching timeline for entity: ${entityId}\n`);
    const timeline = await brain.timeline(entityId);
    console.log(
      `Timeline events (${timeline.events.length}):`,
      JSON.stringify(timeline.events, null, 2),
    );
  } else {
    console.log('No entity ID returned from recall to inspect timeline.');
  }

  console.log('\n✅ Quickstart completed successfully.');
}

main().catch((err: unknown) => {
  console.error('\n❌ Quickstart failed:', err);
  process.exit(1);
});
