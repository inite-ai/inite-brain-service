import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETRIEVAL_CONVEYOR } from '../src/search/conveyor';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';

const root = join(__dirname, '..');
const pipelineSource = readFileSync(join(root, 'src/search/search.service.ts'), 'utf8');
const architectureDoc = readFileSync(join(root, 'docs/architecture.md'), 'utf8');

/** The numbered stage comments the pipeline actually carries, in order. */
function stepsInCode(): string[] {
  return [...pipelineSource.matchAll(/^\s+\/\/ (\d+[a-z]?)\. /gm)].map((m) => m[1]!);
}

/**
 * The conveyor declaration has one job: track the code. A declaration
 * that can drift is a second description of the system, and this repo
 * already paid for one of those — docs/architecture.md still drew a
 * predicate+type router and a HyPE alt-embedding leg months after both
 * were deleted, so the written spec of how the memory works described
 * two links that are not in the chain.
 */
describe('the retrieval conveyor tracks the code', () => {
  it('declares exactly the stages runPipeline runs, in the same order', () => {
    expect(RETRIEVAL_CONVEYOR.map((s) => s.step)).toEqual(stepsInCode());
  });

  it('every declared stage is findable at its own comment', () => {
    for (const stage of RETRIEVAL_CONVEYOR) {
      expect(pipelineSource).toContain(`// ${stage.step}. `);
    }
  });

  it('every env gate names a lane the catalog knows', () => {
    const known = new Set(CONFIG_CATALOG.map((e) => e.key));
    const unknown = RETRIEVAL_CONVEYOR.filter(
      (s) => typeof s.gate === 'object' && 'env' in s.gate && !known.has(s.gate.env),
    ).map((s) => s.step);
    expect(unknown).toEqual([]);
  });

  it('every stage says what it consumes and what it produces', () => {
    for (const stage of RETRIEVAL_CONVEYOR) {
      expect(stage.consumes.length).toBeGreaterThan(10);
      expect(stage.produces.length).toBeGreaterThan(10);
      expect(stage.title.length).toBeGreaterThan(10);
    }
  });
});

/**
 * The stage numbering skips 3, and that is not cosmetic: stage 3 was the
 * predicate/type router's consumption point, deleted in the S1 refactor.
 * Pinned so the scar stays explained — if someone renumbers, they have
 * to decide what to do about the doc too.
 */
describe('the numbering gap is a deletion, not a mistake', () => {
  it('has no stage 3 — the router was removed, and the doc was not', () => {
    expect(stepsInCode()).not.toContain('3');
  });
});

/**
 * The architecture doc is the written spec of the conveyor. When it
 * names a stage, that stage has to exist. These two failed when the test
 * was written, which is why it exists.
 */
describe('docs/architecture.md does not DRAW deleted stages', () => {
  // Only the diagram itself. Prose may name a deleted stage — the note
  // above this diagram does, to explain why it went — and a test that
  // forbade the word would forbid the explanation.
  const diagram = (() => {
    const start = architectureDoc.indexOf('```\n                 query');
    expect(start).toBeGreaterThan(-1);
    return architectureDoc.slice(start, architectureDoc.indexOf('```', start + 3));
  })();

  it('the router is gone from the code, and gone from the diagram', () => {
    expect(/routerPromise|predicateDist|typeDist/.test(pipelineSource)).toBe(false);
    expect(diagram).not.toMatch(/router/i);
  });

  it('the HyPE alt-embedding leg is gone from both', () => {
    // Migration 0143 retired it; the only survivors are that migration
    // and the one that introduced the column.
    expect(diagram).not.toMatch(/alt-emb|HyPE/i);
  });

  it('the diagram still draws the two legs that DO run', () => {
    expect(diagram).toMatch(/vector leg/i);
    expect(diagram).toMatch(/lexical leg/i);
  });
});
