// Path-based change detection for CI job selection.
//
// The design rule here is DENY-LIST, NOT ALLOW-LIST, and it is the whole
// point of the file. deploy-brain.yml (#516) uses an allowlist of paths
// that feed the engine image, guarded by a truth test — that is correct
// for a DEPLOY, where the question is "does this bytes-for-bytes change
// the artifact?" and the Dockerfile answers it mechanically.
//
// CI asks a different and much harder question: "could this change break
// a gate?" Nothing mechanically answers that, because a spec may read any
// file in the repo (test/openapi-doc.unit-spec.ts reads docs/openapi.json
// and brain-landing/public/openapi.json — two paths that look inert and
// are not). An allowlist that misses one of those SILENTLY SKIPS the gate
// that would have caught the regression, which is strictly worse than
// running too much.
//
// So: we enumerate only the buckets that provably feed no engine gate,
// and EVERYTHING ELSE runs everything. A new top-level directory, an
// unrecognised dotfile, a workflow edit — all default to the full suite.
// Being wrong costs runner minutes; being wrong the other way ships a
// regression. The asymmetry decides the default.
//
// SKIP_EXCEPTIONS is the escape hatch for paths that live inside a skip
// bucket but are read by a spec. It is not maintained by hand-vigilance:
// test/ci-change-buckets.unit-spec.ts scans every spec for repo-relative
// reads and fails if any of them resolves into a skip bucket without an
// exception. Add a spec that reads docs/, and CI tells you to come here.

/** Globs whose contents feed the landing app's gates, not the engine's. */
export const WEB_GLOBS = ['brain-landing/**', 'skills/**'];

/** Prose and issue templates. No gate reads these. */
export const DOCS_GLOBS = ['docs/**', '*.md', 'LICENSE', '.github/ISSUE_TEMPLATE/**'];

/** Observability stack config, deployed by deploy-monitoring.yml alone. */
export const MONITORING_GLOBS = ['monitoring/**'];

/**
 * Paths that fall inside a skip bucket above but are nevertheless read by
 * a spec, so a change to them MUST still run the engine gates. Kept honest
 * by test/ci-change-buckets.unit-spec.ts, which derives the required set
 * from the spec sources rather than trusting this list.
 */
export const SKIP_EXCEPTIONS = ['docs/openapi.json', 'brain-landing/public/openapi.json'];

/**
 * Files that change the gates themselves. A CI workflow edit has to run
 * every gate, or the edit is unreviewable — you cannot see the new
 * pipeline's verdict on the PR that introduces it.
 */
export const ALWAYS_EVERYTHING = ['.github/workflows/ci.yml', 'scripts/ci/'];

function matchesGlob(file, glob) {
  if (glob.endsWith('/**')) {
    const dir = glob.slice(0, -3);
    return file === dir || file.startsWith(`${dir}/`);
  }
  if (glob.startsWith('*.')) {
    // Root-level extension glob: '*.md' matches README.md, never docs/a.md.
    return !file.includes('/') && file.endsWith(glob.slice(1));
  }
  return file === glob;
}

function inBucket(file, globs) {
  return globs.some((glob) => matchesGlob(file, glob));
}

function forcesEverything(file) {
  return ALWAYS_EVERYTHING.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/**
 * Classify one changed path.
 * Returns 'everything' | 'web' | 'docs' | 'monitoring' | 'engine'.
 */
export function classifyFile(file) {
  if (forcesEverything(file)) return 'everything';
  if (SKIP_EXCEPTIONS.includes(file)) return 'engine';
  if (inBucket(file, WEB_GLOBS)) return 'web';
  if (inBucket(file, DOCS_GLOBS)) return 'docs';
  if (inBucket(file, MONITORING_GLOBS)) return 'monitoring';
  return 'engine';
}

/**
 * Fold a changed-file list into the two booleans CI selects jobs on.
 * `files` empty (no diff resolvable) is treated as "run everything" —
 * an unresolvable base is a reason to be careful, not a reason to skip.
 */
export function classifyChanges(files) {
  if (files.length === 0) return { engine: true, web: true, reasons: ['no-diff:run-everything'] };

  const reasons = [];
  let engine = false;
  let web = false;

  for (const file of files) {
    const bucket = classifyFile(file);
    if (bucket === 'everything') {
      engine = true;
      web = true;
      reasons.push(`${file} -> everything`);
    } else if (bucket === 'engine') {
      engine = true;
      reasons.push(`${file} -> engine`);
    } else if (bucket === 'web') {
      web = true;
      reasons.push(`${file} -> web`);
    } else {
      reasons.push(`${file} -> ${bucket} (no gate)`);
    }
  }

  return { engine, web, reasons };
}
