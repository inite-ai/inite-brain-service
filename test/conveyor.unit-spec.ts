import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONVEYORS,
  HANDOFFS,
  INGEST_CONVEYOR,
  RETRIEVAL_CONVEYOR,
  SYNTHESIZE_CONVEYOR,
  type Artifact,
} from '../src/conveyor';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

/**
 * THE ASSEMBLY GATES.
 *
 * A declared conveyor earns its place by answering two questions a
 * diagram cannot: is a link missing, is a link doing nothing. Both are
 * checked here across the WHOLE chain — ingest, retrieval, synthesize
 * and the joins between them — so a stage whose output nothing reads, or
 * whose input nothing writes, fails a test instead of surviving a year
 * while both halves report themselves healthy.
 *
 * WHAT IT DOES NOT CATCH, stated so nobody trusts it further than it
 * goes: this is STRUCTURAL. The belief damping stage consumed `belief`
 * and `prompt-sections`, both of which are produced — and it still
 * joined nothing for months, because the two planes keyed the join on
 * incompatible strings. A shape mismatch inside an artifact is invisible
 * here. What this catches is a stage reading something no earlier stage
 * wrote, a stage writing something nothing reads, and a conveyor
 * declaring an input no handoff delivers.
 */
describe('the conveyor — every link is connected', () => {
  const externalInputs = new Set<Artifact>(CONVEYORS.flatMap((c) => [...c.inputs]));
  const terminalOutputs = new Set<Artifact>(CONVEYORS.flatMap((c) => [...c.outputs]));

  /**
   * IN ORDER, PER CONVEYOR — the only version of this check that bites.
   *
   * The first version asked whether an artifact was produced ANYWHERE in
   * the chain, which every artifact trivially is: `citations` is written
   * by synthesize, so a stage in INGEST could declare it as input and
   * the gate stayed green. A probe proved exactly that, which is the
   * only reason this is the second version.
   */
  it('no stage reads an artifact that nothing before it wrote', () => {
    const offenders: string[] = [];
    for (const c of CONVEYORS) {
      const available = new Set<Artifact>(c.inputs);
      for (const s of c.stages) {
        for (const a of s.consumes) {
          if (!available.has(a)) offenders.push(`${c.id}:${s.step} reads ${a}`);
        }
        for (const a of s.produces) available.add(a);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no stage writes an artifact nothing ever reads', () => {
    const consumedSomewhere = new Set<Artifact>(
      CONVEYORS.flatMap((c) => c.stages.flatMap((s) => [...s.consumes])),
    );
    const dead: string[] = [];
    for (const c of CONVEYORS) {
      for (const s of c.stages) {
        for (const a of s.produces) {
          if (!consumedSomewhere.has(a) && !terminalOutputs.has(a)) {
            dead.push(`${c.id}:${s.step} writes ${a}`);
          }
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it("every conveyor's declared input is delivered by a handoff or enters from outside", () => {
    const delivered = new Map<string, Set<Artifact>>();
    for (const h of HANDOFFS) {
      const set = delivered.get(h.to) ?? new Set<Artifact>();
      for (const a of h.via) set.add(a);
      delivered.set(h.to, set);
    }
    // What a caller hands in directly, rather than another conveyor.
    const CALLER_SUPPLIED: readonly Artifact[] = ['turn-text', 'query'];
    const undelivered: string[] = [];
    for (const c of CONVEYORS) {
      for (const a of c.inputs) {
        if (CALLER_SUPPLIED.includes(a)) continue;
        if (!(delivered.get(c.id)?.has(a) ?? false)) undelivered.push(`${c.id} needs ${a}`);
      }
    }
    expect(undelivered).toEqual([]);
  });

  it('every handoff carries something both sides actually declare', () => {
    const byId = new Map(CONVEYORS.map((c) => [c.id, c]));
    for (const h of HANDOFFS) {
      const from = byId.get(h.from);
      const to = byId.get(h.to);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      for (const a of h.via) {
        expect(from!.outputs).toContain(a);
        expect(to!.inputs).toContain(a);
      }
    }
  });

  it('every conveyor output is produced by one of its own stages', () => {
    for (const c of CONVEYORS) {
      const own = new Set(c.stages.flatMap((s) => [...s.produces]));
      for (const a of c.outputs) expect(own.has(a)).toBe(true);
    }
  });

  it('every env gate names a lane the catalog knows', () => {
    const known = new Set(CONFIG_CATALOG.map((e) => e.key));
    const unknown: string[] = [];
    for (const c of CONVEYORS) {
      for (const s of c.stages) {
        if (typeof s.gate === 'object' && 'env' in s.gate && !known.has(s.gate.env)) {
          unknown.push(`${c.id}:${s.step} -> ${s.gate.env}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('every stage says what it does and leaves something behind', () => {
    for (const c of CONVEYORS) {
      for (const s of c.stages) {
        expect(s.title.length).toBeGreaterThan(10);
        expect(s.produces.length).toBeGreaterThan(0);
      }
    }
    expect(externalInputs.size).toBeGreaterThan(0);
  });
});

/**
 * A declaration that can drift is a second description of the system,
 * and this repo already paid for one: docs/architecture.md drew a
 * predicate+type router and a HyPE alt-embedding leg months after both
 * were deleted. Where the code carries numbered stages, the declaration
 * is matched against them.
 */
describe('the conveyor tracks the code where the code is numbered', () => {
  const stepsInCode = (path: string): string[] =>
    [...read(path).matchAll(/^\s+\/\/ (\d+[a-z]?)\. /gm)].map((m) => m[1]!);

  it('retrieval declares exactly the stages runPipeline runs, in order', () => {
    expect(RETRIEVAL_CONVEYOR.tracks).toBe('src/search/search.service.ts');
    expect(RETRIEVAL_CONVEYOR.stages.map((s) => s.step)).toEqual(
      stepsInCode('src/search/search.service.ts'),
    );
  });

  it('the numbering gap is a deletion, not a mistake — there is no stage 3', () => {
    // Stage 3 was the predicate/type router's consumption point, removed
    // in the S1 refactor. Pinned so the scar stays explained.
    expect(stepsInCode('src/search/search.service.ts')).not.toContain('3');
  });

  it('the conveyors whose code is NOT numbered say so, rather than pretending', () => {
    expect(INGEST_CONVEYOR.tracks).toBeUndefined();
    expect(SYNTHESIZE_CONVEYOR.tracks).toBeUndefined();
  });
});

describe('docs/architecture.md does not DRAW deleted stages', () => {
  const doc = read('docs/architecture.md');
  // Only the diagram. Prose may name a deleted stage — the note above it
  // does, to explain why it went — and a test that forbade the word
  // would forbid the explanation.
  const start = doc.indexOf('```\n                 query');
  const diagram = doc.slice(start, doc.indexOf('```', start + 3));

  it('the router is gone from the code, and gone from the diagram', () => {
    expect(start).toBeGreaterThan(-1);
    expect(/routerPromise|predicateDist|typeDist/.test(read('src/search/search.service.ts'))).toBe(
      false,
    );
    expect(diagram).not.toMatch(/router/i);
  });

  it('the HyPE alt-embedding leg is gone from both', () => {
    expect(diagram).not.toMatch(/alt-emb|HyPE/i);
  });

  it('the diagram still draws the two legs that DO run', () => {
    expect(diagram).toMatch(/vector leg/i);
    expect(diagram).toMatch(/lexical leg/i);
  });
});

/**
 * Beliefs and episodes reach the prompt WITHOUT passing through
 * retrieval. Leaving that undeclared is how the belief lane ended up
 * joining nothing — the contract lived in neither plane.
 */
describe('the side-channel into synthesize is declared, not implicit', () => {
  it('beliefs reach the prompt without going through retrieval', () => {
    const direct = HANDOFFS.find((h) => h.from === 'ingest' && h.to === 'synthesize');
    expect(direct?.via).toContain('belief');
    const viaRetrieval = HANDOFFS.find((h) => h.from === 'ingest' && h.to === 'retrieval');
    expect(viaRetrieval?.via).not.toContain('belief');
  });

  it('the damping stage consumes beliefs AND the sections it demotes', () => {
    const damping = SYNTHESIZE_CONVEYOR.stages.find((s) => s.step === 'damping');
    expect(damping?.consumes).toEqual(expect.arrayContaining(['belief', 'prompt-sections']));
  });
});

/** A conveyor nothing reads is a diagram; the search trace reads this one. */
describe('the declaration is consumed', () => {
  it('the search trace emits the retrieval conveyor', () => {
    expect(read('src/search/search.service.ts')).toContain('RETRIEVAL_CONVEYOR');
  });
});
