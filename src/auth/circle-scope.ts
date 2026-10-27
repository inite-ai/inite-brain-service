/**
 * The circle a request — or a job working on its behalf — acts in
 * (docs/roadmap/trust-circles-2026-10.md §3.2–§3.4).
 *
 * A circle is a set of people and agents that memory said inside it
 * stays with: a person and their coach, a facilitated group. A row
 * written while acting in a circle carries `circle:<id>` in its scope
 * next to the user's own tag; the read fences (scope-visibility.ts) then
 * only show it to a principal that holds that tag.
 *
 * Where the acting circle comes from:
 *   - a request: the credential is bound to a circle (`circle` on the
 *     key), and the guard leaves it on the request context;
 *   - a job: the circle travels on the row the job reads (a document's
 *     `scope`), and the job re-enters it with `runInCircle` — the
 *     request context does not survive the hand-off, exactly the reason
 *     write-scope.ts gives for its own ALS.
 *
 * Both only ever NARROW: a circle tag is one more element of a row's
 * AND-set, and one more tag a reader must hold. Nothing here can make a
 * row visible to someone who could not already see it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRequestContext } from '../common/request-context';

/** The namespace of a circle tag: `circle:<id>`. */
export const CIRCLE_NAMESPACE = 'circle';

/** Circle ids are tag tails: no colon, nothing a tag parser would split on. */
export const CIRCLE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

export function circleTag(circleId: string): string {
  return `${CIRCLE_NAMESPACE}:${circleId}`;
}

export function isCircleTag(tag: string): boolean {
  return tag.startsWith(`${CIRCLE_NAMESPACE}:`);
}

/** The circle tags a stored scope carries (what a job re-enters). */
export function circleTagsOf(scope: readonly string[] | undefined | null): string[] {
  return (scope ?? []).filter(isCircleTag);
}

const jobCircle = new AsyncLocalStorage<readonly string[]>();

/** Run `fn` acting in the circles named by `tags` (a job's re-entry). */
export function runInCircle<T>(tags: readonly string[], fn: () => T): T {
  const circles = tags.filter(isCircleTag);
  if (circles.length === 0) return fn();
  return jobCircle.run(circles, fn);
}

/**
 * The circle tags the current work acts in: a job's re-entered circle,
 * else the request credential's. Empty = no circle (today's behaviour).
 */
export function actingCircleTags(): readonly string[] {
  const fromJob = jobCircle.getStore();
  if (fromJob && fromJob.length > 0) return fromJob;
  const id = getRequestContext()?.actingCircle;
  return id ? [circleTag(id)] : [];
}

/**
 * Trust circles §3.5 — what is derived from several rows is visible only
 * where all of them are: the derived row's scope gains every circle tag
 * its sources carry (the AND-set narrows; it never widens).
 */
export function withSourceCircles(
  scope: readonly string[],
  sources: ReadonlyArray<{ scope?: readonly string[] | null | undefined }>,
): string[] {
  const out = [...scope];
  for (const source of sources) {
    for (const tag of circleTagsOf(source.scope)) if (!out.includes(tag)) out.push(tag);
  }
  return out;
}
