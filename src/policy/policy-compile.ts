import {
  CompiledActionRule,
  CompiledCondition,
  CompiledPolicySet,
  CompiledSourceRule,
  MatchCondition,
  PolicyDocument,
  PolicyMacro,
  PolicyRowView,
} from './policy.types';

/**
 * Compiles a validated PolicyDocument into matcher closures so the hot
 * read path pays hash lookups and comparators, never JSON walking.
 * Compilation happens once per resolver cache load (per tenant per TTL),
 * evaluation happens per row — keep everything allocated here.
 */

/** Dotted-path getter over the row view. Precomputed per condition. */
function accessor(attr: string): (view: PolicyRowView) => unknown {
  if (attr === 'predicate') return (v) => v.predicate;
  if (attr === 'piiClass') return (v) => v.piiClass;
  if (attr === 'provenance.purged') return (v) => v.source?.provenancePurged;
  if (attr === 'userId') return (v) => v.userId;
  if (attr === 'corroboration.count') return (v) => v.corroboration?.count;
  if (attr.startsWith('trust.')) {
    const key = attr.slice('trust.'.length) as 'authority' | 'declaredTrust' | 'learnedTrust';
    return (v) => v.trustSnapshot?.[key];
  }
  if (attr.startsWith('source.meta.')) {
    const key = attr.slice('source.meta.'.length);
    return (v) => {
      const meta = v.source?.meta;
      if (meta === null || typeof meta !== 'object') return undefined;
      return (meta as Record<string, unknown>)[key];
    };
  }
  if (attr.startsWith('source.')) {
    const key = attr.slice('source.'.length);
    return (v) => v.source?.[key];
  }
  return () => undefined;
}

function compileCondition(cond: MatchCondition): CompiledCondition {
  const get = accessor(cond.attr);
  const { attr, op } = cond;

  // Absent attribute never matches a value-comparing rule; only
  // not_exists matches absence. Null and undefined are both "absent".
  const present = (x: unknown) => x !== undefined && x !== null;

  let expected: CompiledCondition['expected'] = null;
  let matches: (view: PolicyRowView) => boolean;

  switch (op) {
    case 'exists':
      matches = (v) => present(get(v));
      break;
    case 'not_exists':
      matches = (v) => !present(get(v));
      break;
    case 'eq': {
      const want = cond.value as string | number | boolean;
      expected = want;
      matches = (v) => {
        const x = get(v);
        return present(x) && x === want;
      };
      break;
    }
    case 'in': {
      const set = new Set(cond.value as string[]);
      expected = set;
      matches = (v) => {
        const x = get(v);
        return typeof x === 'string' && set.has(x);
      };
      break;
    }
    case 'prefix': {
      const want = cond.value as string;
      expected = want;
      matches = (v) => {
        const x = get(v);
        return typeof x === 'string' && x.startsWith(want);
      };
      break;
    }
    case 'gte':
    case 'gt':
    case 'lte':
    case 'lt': {
      const want = cond.value as number;
      expected = want;
      matches = (v) => {
        const x = get(v);
        if (typeof x !== 'number' || !Number.isFinite(x)) return false;
        if (op === 'gte') return x >= want;
        if (op === 'gt') return x > want;
        if (op === 'lte') return x <= want;
        return x < want;
      };
      break;
    }
  }

  return { attr, op, expected, matches, actual: get };
}

function compileSourceRule(rule: {
  id: string;
  effect: 'allow' | 'deny';
  match?: MatchCondition[] | undefined;
}): CompiledSourceRule {
  return {
    id: rule.id,
    effect: rule.effect,
    conditions: (rule.match ?? []).map(compileCondition),
  };
}

function compileActionRule(rule: {
  id: string;
  effect: 'allow' | 'deny';
  actions?: string[] | undefined;
}): CompiledActionRule {
  const names = new Set<string>();
  const macros = new Set<PolicyMacro>();
  for (const a of rule.actions ?? []) {
    if (a.startsWith('@')) macros.add(a as PolicyMacro);
    else names.add(a);
  }
  return { id: rule.id, effect: rule.effect, names, macros };
}

/**
 * Compile one document. Disabled sets and sets outside their
 * activeFrom/activeUntil window return null — the resolver drops them
 * from the context entirely (same silent-skip semantics as disabled:
 * a temporal window is an operator schedule, not a dangling
 * reference). Window edges take effect within one resolver cache TTL
 * (POLICY_CACHE_TTL_MS, default 60 s) — compile happens per cache
 * load, not per request.
 */
export function compilePolicySet(
  doc: PolicyDocument,
  now: Date = new Date(),
): CompiledPolicySet | null {
  if (doc.mode === 'disabled') return null;
  if (doc.activeFrom && now < new Date(doc.activeFrom)) return null;
  if (doc.activeUntil && now >= new Date(doc.activeUntil)) return null;

  const actionDeny: CompiledActionRule[] = [];
  const actionAllow: CompiledActionRule[] = [];
  const sourceDeny: CompiledSourceRule[] = [];
  const sourceAllow: CompiledSourceRule[] = [];

  for (const rule of doc.rules) {
    if (!rule.enabled) continue;
    if (rule.kind === 'action') {
      (rule.effect === 'deny' ? actionDeny : actionAllow).push(compileActionRule(rule));
    } else {
      (rule.effect === 'deny' ? sourceDeny : sourceAllow).push(compileSourceRule(rule));
    }
  }

  return {
    name: doc.name,
    mode: doc.mode,
    posture: doc.posture,
    actionDeny,
    actionAllow,
    sourceDeny,
    sourceAllow,
    document: doc,
  };
}

/**
 * Fail-closed sentinel set: injected by the resolver when a key
 * references a policy name that doesn't resolve. Denies everything in
 * enforce mode so a deleted/mistyped set can never silently widen
 * access.
 */
export function denyAllSet(name: string): CompiledPolicySet {
  const doc: PolicyDocument = {
    name,
    description: 'fail-closed: referenced policy set not found',
    posture: { actions: 'deny', reads: 'deny' },
    mode: 'enforce',
    rules: [],
  };
  return {
    name,
    mode: 'enforce',
    posture: doc.posture,
    actionDeny: [],
    actionAllow: [],
    sourceDeny: [],
    sourceAllow: [],
    document: doc,
  };
}
