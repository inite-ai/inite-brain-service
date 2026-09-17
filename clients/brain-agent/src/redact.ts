/**
 * Local redaction — what leaves the machine is text; secrets in it must
 * not. A small, deterministic pass over the shapes that are unmistakably
 * credentials (cloud keys, platform tokens, private-key blocks, bearer
 * headers, `key=value` assignments of secret-named keys). Each hit is
 * replaced with a typed marker so a fact can still say "a token was
 * here" without carrying it. On by default; `--no-redact` turns it off
 * for a source the operator knows is clean.
 */
const RULES: Array<[string, RegExp]> = [
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['stripe_key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g],
  [
    'secret_assignment',
    /\b((?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
  ],
];

export function redactSecrets(text: string): { text: string; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  let out = text;
  for (const [kind, re] of RULES) {
    out = out.replace(re, (whole: string, ...groups: unknown[]) => {
      hits[kind] = (hits[kind] ?? 0) + 1;
      // The assignment rule keeps the key name and hides the value only.
      if (kind === 'secret_assignment' && typeof groups[0] === 'string') return `${groups[0]}[redacted:${kind}]`;
      void whole;
      return `[redacted:${kind}]`;
    });
  }
  return { text: out, hits };
}
