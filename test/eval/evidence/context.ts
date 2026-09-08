/**
 * The execution context every evidence check receives, plus the handful
 * of assertions they share.
 *
 * Kept apart from the check tables so the two halves of the battery
 * (`checks-plane.ts` for ingest→fragments, `checks-access.ts` for
 * citations→erasure) can be read on their own and neither file grows past
 * the repo's 800-line gate.
 *
 * Identity discipline (the #456 hermeticity doctrine): NOTHING here has a
 * fixed default. Every user handle, pack id and byte payload is salted
 * with the run id by the runner before it lands in this context, so a
 * second run against the same tenant can neither dedupe onto the first
 * run's content-addressed rows nor inherit its grants.
 */
import type { Gates, Stand, Verdict } from './types';
import { fail, pass } from './types';
import type { Wire } from './wire';

export interface Ctx {
  /** Tenant A — the tenant under test. */
  wire: Wire;
  /** Tenant B, when the operator supplied a second credential. */
  wireB: Wire | null;
  runId: string;
  /** Owner of the primary + spare assets. */
  ownerUserId: string;
  /** The user GDPR erasure destroys in phase 3. */
  forgetUserId: string;
  /** Co-owner of the shared asset; must outlive the erasure. */
  survivorUserId: string;
  /** Ceiling on any deliberate wait (signed-URL expiry), in seconds. */
  maxWaitSeconds: number;
  /** Whether the operator opted into model spend for the serving leg. */
  allowSynthesize: boolean;
  gates: Gates;
  stand: Stand;
}

/** Live value of one env knob as the stand reports it, or '' when absent. */
export const knob = (ctx: Ctx, key: string): string => ctx.gates.config.get(key) ?? '';

/** Whether a knob reads as enabled — the stand prints booleans as 0/1. */
export const knobOn = (ctx: Ctx, key: string): boolean => {
  const raw = knob(ctx, key).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
};

/** Verdict helper: one expected status, with the body in the detail. */
export function expectStatus(
  observed: { status: number; text: string },
  want: number,
  label: string,
): Verdict {
  if (observed.status === want) return pass(`${label}: HTTP ${want}`);
  return fail(`${label}: expected HTTP ${want}, got ${observed.status} — ${observed.text}`);
}

/** Verdict helper: the status must be one of a small allowed set. */
export function expectOneOf(
  observed: { status: number; text: string },
  want: readonly number[],
  label: string,
): Verdict {
  if (want.includes(observed.status)) return pass(`${label}: HTTP ${observed.status}`);
  return fail(
    `${label}: expected HTTP ${want.join('|')}, got ${observed.status} — ${observed.text}`,
  );
}

/**
 * Collect failures as prose. A check that asserts five things about one
 * response should say which of them broke, not merely that one did — the
 * report file is meant to be reproducible from its detail line alone.
 */
export class Findings {
  private readonly problems: string[] = [];
  private readonly confirmed: string[] = [];

  ok(condition: boolean, whenTrue: string, whenFalse: string): void {
    if (condition) this.confirmed.push(whenTrue);
    else this.problems.push(whenFalse);
  }

  verdict(): Verdict {
    if (this.problems.length === 0) return pass(this.confirmed.join('; '));
    return fail(this.problems.join('; '));
  }
}
