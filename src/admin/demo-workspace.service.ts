import { Injectable } from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { DEMO_ORG_ID, DEMO_ORG_NAME } from '../demo/demo-tenant';

/**
 * DemoWorkspaceService — the DB reads behind the public demo workspace
 * (Ana's workspace at «Atlântica Group (demo)»): the graph, the sources it
 * was built from, and the counts. Reads only the demo tenant, only
 * tenant-global rows (`userId IS NONE`), and never writes. Bounded: the
 * demo pack is a few dozen rows, the LIMITs only keep a stray import from
 * turning a page load into a table scan.
 *
 * Sources are read back from the facts' own `source.evidence` refs, so
 * the list is what the graph holds, not a copy of the pack.
 */

export interface WorkspaceEntity {
  id: string;
  type: string;
  name: string;
}

export interface WorkspaceFact {
  id: string;
  entityId: string;
  predicate: string;
  object: string;
  validFrom: string;
  validUntil: string | null;
  status: string;
  sourceRef: string | null;
}

export interface WorkspaceEdge {
  from: string;
  to: string;
  kind: string;
}

export interface WorkspaceSource {
  ref: string;
  kind: string;
  title: string;
  facts: number;
}

export interface WorkspaceGraph {
  org: { id: string; name: string };
  entities: WorkspaceEntity[];
  facts: WorkspaceFact[];
  edges: WorkspaceEdge[];
  sources: WorkspaceSource[];
}

type Evidence = { kind?: string; ref?: string; note?: string };

const iso = (v: unknown): string | null =>
  v === undefined || v === null ? null : new Date(String(v)).toISOString();

@Injectable()
export class DemoWorkspaceService {
  constructor(private readonly surreal: SurrealService) {}

  async graph(): Promise<WorkspaceGraph> {
    const empty: WorkspaceGraph = {
      org: { id: DEMO_ORG_ID, name: DEMO_ORG_NAME },
      entities: [],
      facts: [],
      edges: [],
      sources: [],
    };
    try {
      return await this.surreal.withCompany(DEMO_ORG_ID, async (db) => {
        const [entities, facts, edges] = await db.query<
          [
            Array<{ id: unknown; type: string; canonicalName: string }>,
            Array<{
              id: unknown;
              entityId: unknown;
              predicate: string;
              object: string;
              validFrom: unknown;
              validUntil?: unknown;
              status: string;
              evidence?: Evidence[];
            }>,
            Array<{ in: unknown; out: unknown; kind: string }>,
          ]
        >(
          `SELECT id, type, canonicalName FROM knowledge_entity
             WHERE mergedInto IS NONE AND userId IS NONE LIMIT 500;
           SELECT id, entityId, predicate, object, validFrom, validUntil, status,
                  source.evidence AS evidence
             FROM knowledge_fact
             WHERE retractedAt IS NONE AND userId IS NONE
               AND status INSIDE ['active', 'superseded']
             ORDER BY validFrom ASC LIMIT 2000;
           SELECT in, out, kind FROM knowledge_edge
             WHERE invalidatedAt IS NONE AND userId IS NONE LIMIT 2000;`,
        );
        return shapeGraph(empty, {
          entities: entities ?? [],
          facts: facts ?? [],
          edges: edges ?? [],
        });
      });
    } catch {
      // No demo tenant yet (not seeded): an empty workspace, not an error.
      return empty;
    }
  }
}

type RawRows = {
  entities: Array<{ id: unknown; type: string; canonicalName: string }>;
  facts: Array<{
    id: unknown;
    entityId: unknown;
    predicate: string;
    object: string;
    validFrom: unknown;
    validUntil?: unknown;
    status: string;
    evidence?: Evidence[];
  }>;
  edges: Array<{ in: unknown; out: unknown; kind: string }>;
};

function shapeGraph(empty: WorkspaceGraph, { entities, facts, edges }: RawRows): WorkspaceGraph {
  const sources = new Map<string, WorkspaceSource>();
  const shapedFacts = facts.map((f) => {
    const ev = Array.isArray(f.evidence) ? f.evidence[0] : undefined;
    const ref = typeof ev?.ref === 'string' ? ev.ref : null;
    if (ref) {
      const s = sources.get(ref) ?? {
        ref,
        kind: ev?.kind ?? 'other',
        title: ev?.note ?? ref,
        facts: 0,
      };
      s.facts += 1;
      sources.set(ref, s);
    }
    return {
      id: String(f.id),
      entityId: String(f.entityId),
      predicate: f.predicate,
      object: f.object,
      validFrom: iso(f.validFrom) ?? '',
      validUntil: iso(f.validUntil),
      status: f.status,
      sourceRef: ref,
    };
  });
  return {
    ...empty,
    entities: entities.map((e) => ({ id: String(e.id), type: e.type, name: e.canonicalName })),
    facts: shapedFacts,
    edges: edges.map((e) => ({ from: String(e.in), to: String(e.out), kind: e.kind })),
    sources: [...sources.values()].sort((a, b) => a.title.localeCompare(b.title)),
  };
}
