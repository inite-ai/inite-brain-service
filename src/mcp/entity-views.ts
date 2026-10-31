import type { EntityProfile, TimelineEvent } from '../entities/entities.service';
import type { BeliefReadResult } from '../beliefs/beliefs.service';
import type { SceneReadResult } from '../scenes/scenes.service';

/**
 * get_entity_profile / get_entity_timeline at the coarse level of the
 * memory, the way ReadAgent (Lee et al., 2024) reads a long history: the
 * gist first, the pages on demand. Listing every fact of the corpus's
 * central entity cost more than the raw conversation it came from
 * (memory-fitness stand, 2026-10-31: profile 1.13×, timeline 1.62× raw)
 * — the entity a conversation is about collects nearly every fact said.
 *
 * Profile: the entity's current state as the belief plane distilled it
 * (one statement per attribute, with the value it replaced), the facts
 * in dispute, and an index of every attribute with recorded facts — what
 * `detail: "compact"` lists in full.
 *
 * Timeline: the scenes its facts were read from, oldest first — each
 * scene's gist and the entity's state changes in it — and, one line
 * each, the facts no visible scene contains (direct writes, documents).
 */

const day = (v: string | undefined): string => (v ? v.slice(0, 10) : '?');

/** The profile's gist; null when there is no belief about the entity to stand in for its facts. */
export function profileGist(p: EntityProfile, beliefs: BeliefReadResult[]): string | null {
  if (beliefs.length === 0) return null;
  const head = `${p.canonicalName} (${p.type})${p.mergedInto ? ` — merged into ${p.mergedInto}` : ''}`;
  const state = [...beliefs]
    .sort((a, b) => a.field.localeCompare(b.field))
    .map(
      (b) =>
        `  ${b.field}: ${b.value}${b.priorValue ? ` (was: ${b.priorValue})` : ''} — since ${day(b.validFrom)}`,
    );
  const disputed = new Map<string, string[]>();
  for (const f of p.facts) {
    if (f.status !== 'competing') continue;
    disputed.set(f.predicate, [...(disputed.get(f.predicate) ?? []), f.object]);
  }
  const counts = new Map<string, number>();
  for (const f of p.facts) counts.set(f.predicate, (counts.get(f.predicate) ?? 0) + 1);
  const index = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([predicate, n]) => (n > 1 ? `${predicate} ×${n}` : predicate));
  return [
    head,
    'now:',
    ...state,
    ...(disputed.size > 0
      ? ['disputed:', ...[...disputed].map(([pr, values]) => `  ${pr}: ${values.join(' | ')}`)]
      : []),
    `recorded: ${p.facts.length} current facts — ${index.join(', ')} (detail "compact" lists them)`,
  ].join('\n');
}

/** The turns a timeline event's fact was read from. */
function episodesOf(e: TimelineEvent): string[] {
  if (e.type !== 'fact.recorded') return [];
  const ids = (e.source as { episodeIds?: unknown } | null | undefined)?.episodeIds;
  return Array.isArray(ids) ? ids.map(String) : [];
}

/** Every turn the timeline's facts were read from — what the scenes are looked up by. */
export function timelineEpisodes(events: TimelineEvent[]): string[] {
  return [...new Set(events.flatMap(episodesOf))];
}

/** The timeline's gist; null when no visible scene contains any of its facts' turns. */
export function timelineGist(
  out: { canonicalName?: string; events: TimelineEvent[] },
  scenes: SceneReadResult[],
): string | null {
  if (scenes.length === 0) return null;
  const inScene = new Set(scenes.flatMap((s) => s.episodeIds));
  const name = out.canonicalName?.toLowerCase();
  const sceneLines = scenes.flatMap((s) => [
    `${day(s.occurredFrom)} · ${s.enrichedGist ?? s.gist}`,
    ...s.stateDeltas
      .filter((d) => name !== undefined && d.subject.toLowerCase() === name)
      .map((d) => `  ${d.field}: ${d.from ? `${d.from} → ` : ''}${d.to ?? '(ended)'}`),
  ]);
  const outside = out.events.flatMap((e) =>
    e.type === 'fact.recorded' && !episodesOf(e).some((id) => inScene.has(id))
      ? [`${day(e.validFrom)} + ${e.predicate} = ${e.object}`]
      : [],
  );
  return [
    ...sceneLines,
    ...(outside.length > 0 ? ['not from a conversation:', ...outside] : []),
  ].join('\n');
}
