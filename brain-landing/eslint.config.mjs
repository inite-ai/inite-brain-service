// @ts-check
import reactPlugin from 'eslint-plugin-react';
import tsParser from '@typescript-eslint/parser';

/**
 * ESLint flat config — brain-landing.
 *
 * SCOPE: i18n gate ONLY. Next.js handles its own lint via `next lint`
 * (separate config inside the framework). This file's single job is
 * to fail PRs that introduce hardcoded user-facing strings.
 *
 * The rule: `react/jsx-no-literals`. Every user-facing string must
 * come from a translation dictionary (`lib/i18n.ts` → `locales/<lang>
 * /common.json`). Hardcoded JSX literals get caught at lint time.
 *
 * Why this matters: pre-Phase-J, several admin components (LeasesPanel,
 * JobsPanel, MaintenancePanel) shipped with hardcoded English strings.
 * The codebase has a working i18n pipeline — only enforcement was
 * missing. Without a build-time gate, every new component repeats
 * the mistake because nothing blocks the wrong shape at PR time.
 *
 * Allowed string escapes:
 *   - Pure symbols (—, …, →, /, ·, ✓, ✗, :, ,) — typography that's
 *     never translated.
 *
 * Numeric literals inside JSX are allowed by the rule's default —
 * stats / counters / latency-in-ms genuinely render numbers; only
 * prose needs i18n discipline.
 *
 * Per-file opt-out (legacy files queued for a separate i18n pass):
 *   // eslint-disable react/jsx-no-literals -- TODO i18n pass
 * at file top makes the technical debt grep-able.
 *
 * Run: `pnpm lint:i18n`
 */
export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'out/**'],
  },
  {
    files: ['app/**/*.{ts,tsx,jsx}', 'components/**/*.{ts,tsx,jsx}'],
    plugins: { react: reactPlugin },
    settings: { react: { version: 'detect' } },
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'react/jsx-no-literals': [
        'error',
        {
          noStrings: false,
          allowedStrings: [
            '—',
            '…',
            '→',
            '/',
            '·',
            '✓',
            '✗',
            ':',
            ',',
            ' ',
          ],
          ignoreProps: true,
        },
      ],
    },
  },
];
