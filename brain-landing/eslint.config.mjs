// @ts-check
import next from 'eslint-config-next';
import reactPlugin from 'eslint-plugin-react';
import tsParser from '@typescript-eslint/parser';

/**
 * ESLint flat config — brain-landing.
 *
 * Two layers:
 *
 *  1. **General lint** — Next.js's own recommended flat config
 *     (`eslint-config-next`: core-web-vitals + TS rules). Next 16 removed the
 *     `next lint` command, so linting is a plain `eslint .` against this
 *     config; `pnpm lint` runs the whole project through it, in CI too.
 *
 *  2. **i18n gate** — `react/jsx-no-literals`, scoped to `components/admin/**`.
 *     Admin UI strings must come from a translation dictionary
 *     (`lib/i18n.ts` → `locales/<lang>/common.json`); a hardcoded JSX literal
 *     there fails the build. Marketing / docs / demo pages legitimately render
 *     literal English prose, so the rule deliberately does NOT apply to them —
 *     that's why it's file-scoped rather than global.
 *
 * Allowed string escapes are pure typography (—, …, →, /, ·, ✓, ✗, :, ,) that
 * is never translated. Numeric literals are allowed by the rule default.
 * Per-file opt-out for legacy admin files queued for an i18n pass:
 *   // eslint-disable react/jsx-no-literals -- TODO i18n pass
 *
 * Run: `pnpm lint` (full) or `pnpm lint:i18n` (admin i18n gate only).
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'public/**', 'out/**'],
  },
  ...next,
  {
    // react-hooks 7 (Next 16) added stricter rules that flag patterns which are
    // widespread and intentional in this dashboard — fetch-in-effect + setState,
    // d3-force refs mutated across renders. Kept as warnings (visible, tracked
    // as tech debt) so the CI gate blocks on genuine errors without a mass
    // hook-refactor. Burn these down file-by-file, then promote back to error.
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/incompatible-library': 'warn',
    },
  },
  {
    files: ['components/admin/**/*.{ts,tsx,jsx}'],
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

export default config;
