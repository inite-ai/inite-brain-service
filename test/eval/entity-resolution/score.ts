/**
 * Scoring for the entity-resolution battery — pure, no I/O.
 *
 * A run assigns every mention to an entity; the gold labels assign it to a
 * cluster. Reported:
 *  - pairwise precision / recall / F1 over mention pairs (the standard ER
 *    pair metric: a predicted merge is a pair resolved to one entity);
 *  - B³ precision / recall / F1 (per-mention, so a large cluster does not
 *    drown the small ones);
 *  - auto-merge precision: of the mentions a deterministic rung attached to
 *    an existing entity, how many landed on their own cluster — a false
 *    merge is the error that fuses two people's memory, and no judge
 *    looked at it;
 *  - escalation: of the gold same-entity links (a mention whose cluster
 *    already existed), how many the deterministic rungs settled and how
 *    many were left to the judge or missed;
 *  - per category and per rung breakdowns.
 */

export interface Mention {
  id: string;
  cluster: string;
  category: string;
}

export interface Assignment {
  mentionId: string;
  entityId: string;
  /** The ladder rung that settled the mention (`created` = a new entity). */
  rung: string;
}

export interface PRF {
  precision: number;
  recall: number;
  f1: number;
}

export interface CategoryRow {
  category: string;
  /** Mentions whose cluster already existed — each should join it. */
  links: number;
  /** Of those, how many joined an entity holding their cluster. */
  joined: number;
  /** Mentions of this category attached to an entity of ANOTHER cluster. */
  falseMerges: number;
}

export interface Score {
  pairwise: PRF & { truePairs: number; predictedPairs: number; correctPairs: number };
  bcubed: PRF;
  autoMerge: { attached: number; correct: number; precision: number };
  escalation: { links: number; settledByLadder: number; byJudge: number; missed: number };
  rungs: Record<string, number>;
  categories: CategoryRow[];
  falseMerges: Array<{ mentionId: string; entityHolds: string[]; rung: string }>;
  missedLinks: Array<{ mentionId: string; cluster: string; category: string; rung: string }>;
}

const DETERMINISTIC_ATTACH = new Set([
  'hint',
  'known',
  'exact',
  'article-variant',
  'translit',
  'code-alias',
]);

function prf(precision: number, recall: number): PRF {
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);

export function score(mentions: Mention[], assignments: Assignment[]): Score {
  const byId = new Map(mentions.map((m) => [m.id, m]));
  const ordered = assignments.filter((a) => byId.has(a.mentionId));

  // Pairwise.
  let truePairs = 0;
  let predictedPairs = 0;
  let correctPairs = 0;
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      const same = byId.get(a.mentionId)!.cluster === byId.get(b.mentionId)!.cluster;
      const merged = a.entityId === b.entityId;
      if (same) truePairs++;
      if (merged) predictedPairs++;
      if (same && merged) correctPairs++;
    }
  }

  // B³.
  const byEntity = new Map<string, string[]>();
  const byCluster = new Map<string, string[]>();
  for (const a of ordered) {
    const m = byId.get(a.mentionId)!;
    byEntity.set(a.entityId, [...(byEntity.get(a.entityId) ?? []), m.cluster]);
    byCluster.set(m.cluster, [...(byCluster.get(m.cluster) ?? []), a.entityId]);
  }
  let bp = 0;
  let br = 0;
  for (const a of ordered) {
    const cluster = byId.get(a.mentionId)!.cluster;
    const entityMembers = byEntity.get(a.entityId)!;
    const clusterMembers = byCluster.get(cluster)!;
    bp += entityMembers.filter((c) => c === cluster).length / entityMembers.length;
    br += clusterMembers.filter((e) => e === a.entityId).length / clusterMembers.length;
  }

  // Walk in ingest order for links, auto-merges and per-category rows.
  const seenClusterEntities = new Map<string, Set<string>>();
  const entityClusters = new Map<string, Set<string>>();
  const rungs: Record<string, number> = {};
  const cats = new Map<string, CategoryRow>();
  const row = (category: string) => {
    const r = cats.get(category) ?? { category, links: 0, joined: 0, falseMerges: 0 };
    cats.set(category, r);
    return r;
  };
  let attached = 0;
  let attachedCorrect = 0;
  let settledByLadder = 0;
  let byJudge = 0;
  let missed = 0;
  let links = 0;
  const falseMerges: Score['falseMerges'] = [];
  const missedLinks: Score['missedLinks'] = [];
  for (const a of ordered) {
    const m = byId.get(a.mentionId)!;
    rungs[a.rung] = (rungs[a.rung] ?? 0) + 1;
    const r = row(m.category);
    const prior = seenClusterEntities.get(m.cluster);
    const holds = entityClusters.get(a.entityId);
    const joinedOwn = prior !== undefined && prior.has(a.entityId);
    const attachedToOther = holds !== undefined && !holds.has(m.cluster);
    if (prior !== undefined) {
      links++;
      r.links++;
      if (joinedOwn) {
        r.joined++;
        if (a.rung === 'judge') byJudge++;
        else settledByLadder++;
      } else {
        missed++;
        missedLinks.push({
          mentionId: m.id,
          cluster: m.cluster,
          category: m.category,
          rung: a.rung,
        });
      }
    }
    if (attachedToOther) {
      r.falseMerges++;
      falseMerges.push({ mentionId: m.id, entityHolds: [...holds], rung: a.rung });
    }
    if (holds !== undefined && DETERMINISTIC_ATTACH.has(a.rung)) {
      attached++;
      if (!attachedToOther) attachedCorrect++;
    }
    seenClusterEntities.set(m.cluster, (prior ?? new Set()).add(a.entityId));
    entityClusters.set(a.entityId, (holds ?? new Set()).add(m.cluster));
  }

  return {
    pairwise: {
      ...prf(ratio(correctPairs, predictedPairs), ratio(correctPairs, truePairs)),
      truePairs,
      predictedPairs,
      correctPairs,
    },
    bcubed: prf(bp / Math.max(1, ordered.length), br / Math.max(1, ordered.length)),
    autoMerge: { attached, correct: attachedCorrect, precision: ratio(attachedCorrect, attached) },
    escalation: { links, settledByLadder, byJudge, missed },
    rungs,
    categories: [...cats.values()].sort((x, y) => x.category.localeCompare(y.category)),
    falseMerges,
    missedLinks,
  };
}
