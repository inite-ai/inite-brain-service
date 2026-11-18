#!/usr/bin/env node
// The `supply-chain` verdict over `pnpm audit --json`, read from stdin:
//
//   pnpm audit --json --ignore-workspace | node scripts/ci/audit.mjs
//
// Any high or critical advisory fails, in every dependency (dev included:
// this repo's gate is stricter than the family's prod-only one), unless
// .inite/audit-allow.json names it with a reason and a date it expires,
// the family's format (inite-shared devops/standards/lib/audit.mjs):
//
//   [{ "advisory": "GHSA-xxxx-xxxx-xxxx", "package": "x", "reason": "...", "expires": "YYYY-MM-DD" }]
//
// An allowance is a deadline, not a silence: an entry without a reason,
// without a date, past its date or more than 90 days out fails the gate.
// It exists for an advisory with no patched release; anything with a fix
// is upgraded instead.
//
// AUDIT_TODAY (YYYY-MM-DD) and AUDIT_ALLOW_JSON (the list's text) stand in
// for the date and the file, for the unit spec only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOW = '.inite/audit-allow.json';
const BAD = new Set(['high', 'critical']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const today = process.env.AUDIT_TODAY ?? new Date().toISOString().slice(0, 10);
const horizon = new Date(Date.parse(today) + 90 * 86400000).toISOString().slice(0, 10);

let json;
try {
  json = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  console.error('[audit] pnpm audit gave no JSON; the gate cannot judge, so it fails');
  process.exit(1);
}
if (json?.error) {
  console.error(
    `[audit] pnpm audit failed: ${json.error.code ?? ''} ${json.error.message ?? ''}`.trim(),
  );
  process.exit(1);
}

const allowFile = path.join(ROOT, ALLOW);
const allow = process.env.AUDIT_ALLOW_JSON
  ? JSON.parse(process.env.AUDIT_ALLOW_JSON)
  : fs.existsSync(allowFile)
    ? JSON.parse(fs.readFileSync(allowFile, 'utf8'))
    : [];
const problems = [];

for (const e of allow) {
  const name = e.advisory ?? e.package;
  if (!e.advisory) problems.push(`${ALLOW}: ${name} names no advisory id`);
  if (!e.reason || e.reason.length < 8) problems.push(`${ALLOW}: ${name} needs a reason`);
  if (!DAY.test(e.expires ?? ''))
    problems.push(`${ALLOW}: ${name} needs an "expires" date (YYYY-MM-DD)`);
  else if (e.expires < today)
    problems.push(
      `${ALLOW}: ${name} expired on ${e.expires}; upgrade or renew it with a new reason`,
    );
  else if (e.expires > horizon) problems.push(`${ALLOW}: ${name} is allowed past 90 days`);
}

const live = (a) =>
  allow.some(
    (e) =>
      e.advisory === a.github_advisory_id &&
      DAY.test(e.expires ?? '') &&
      e.expires >= today &&
      e.expires <= horizon &&
      (e.reason ?? '').length >= 8,
  );

let allowed = 0;
for (const a of Object.values(json?.advisories ?? {})) {
  if (!BAD.has(a.severity)) continue;
  if (live(a)) {
    allowed++;
    console.log(
      `[audit] allowed until listed date: ${a.severity} ${a.module_name} ${a.github_advisory_id}`,
    );
    continue;
  }
  problems.push(
    `${a.severity}: ${a.module_name} ${a.github_advisory_id} ${a.title ?? ''} (patched: ${a.patched_versions ?? '?'})`.trim(),
  );
}

if (problems.length) {
  for (const p of problems) console.error(`[audit] ${p}`);
  process.exit(1);
}
console.log(`[audit] no high or critical advisory outside ${ALLOW} (${allowed} allowed)`);
