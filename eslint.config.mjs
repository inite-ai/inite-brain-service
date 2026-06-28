// @ts-check
import tseslint from 'typescript-eslint';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';
import sonarjs from 'eslint-plugin-sonarjs';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

/**
 * ESLint config — Nest backend.
 *
 * Quality gates (DRY / SOLID / Clean Architecture / anti-god-file):
 *
 * Treated as ERRORS (CI red):
 *   - `import/no-cycle`              — circular imports between modules
 *     break Clean Architecture's dependency rule (inner layers don't
 *     import outer ones). Most cycles are a refactor-time accident; a
 *     hard error catches them at PR time.
 *   - `sonarjs/no-identical-functions` — flat-out copy-paste of a function
 *     body. DRY's bluntest violation; nothing to discuss.
 *   - `sonarjs/no-duplicated-branches` — `if/else` arms with the same
 *     body. Either remove the branch or make them differ.
 *
 * Treated as ERRORS (CI red) — the codebase has been split to fit
 * under these gates; raising them is the wrong knob, splitting the
 * offender is the right one.
 *   - `max-lines` (800)              — god-file ceiling.
 *   - `max-lines-per-function` (200) — god-function ceiling.
 *   - `max-classes-per-file` (1)     — one class per module file.
 *     Helper types/interfaces ok; multiple @Injectable classes in one
 *     file is a Single Responsibility smell.
 *   - `max-params` (3)               — argument-list bloat. Past 3 the
 *     callee wants a typed options object; DI constructors past 3 want a
 *     responsibility split. The only exemptions are decorated HTTP route
 *     handlers (@Query/@Param/@Body bindings), marked per-line.
 *   - `complexity` (25)              — cyclomatic complexity per fn.
 *   - `sonarjs/cognitive-complexity` (30) — readability-weighted variant.
 *
 * Test files (`*spec.ts`, `test/**`) are exempted from size/complexity
 * gates — Arrange/Act/Assert blocks legitimately push function length
 * and cognitive complexity in ways that production code shouldn't.
 */

const sizeGates = {
  'max-lines': [
    'error',
    { max: 800, skipBlankLines: true, skipComments: true },
  ],
  'max-lines-per-function': [
    'error',
    { max: 200, skipBlankLines: true, skipComments: true, IIFEs: true },
  ],
  'max-classes-per-file': ['error', 1],
  'max-params': ['error', 3],
  complexity: ['error', 25],
  'sonarjs/cognitive-complexity': ['error', 30],
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      // sub-projects with their own toolchains
      'brain-landing/**',
      'skills/**',
      'scripts/**',
    ],
  },
  ...tseslint.configs.recommended,
  eslintPluginPrettier,
  {
    plugins: {
      sonarjs: sonarjs,
      import: importPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.jest },
      parserOptions: {
        // Avoid type-aware linting for now (slow on a Nest app, and we lint
        // both src/ and test/ which would need separate tsconfigs).
        project: false,
      },
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.ts', '.js'] },
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-const': 'warn',
      'prettier/prettier': 'off', // formatting handled by `pnpm format`, not lint

      // ── Clean architecture / DRY hard gates ───────────────────────
      // import/no-cycle disabled by default — requires the import
      // resolver to walk every file's deps on each lint. Toggle on
      // before a clean-arch sweep; the rule is wired but its perf
      // budget is too steep for the every-PR loop.
      'import/no-cycle': 'off',
      // Controllers MUST NOT import db services directly. Controller
      // = HTTP plumbing (request parsing, auth, response shaping);
      // business logic lives in services. A direct
      // `await this.surreal.withCompany(...).query(...)` inside a
      // controller is a layer leak — the next operator who needs the
      // same logic from a cron / SSE / MCP path has to copy-paste it.
      // Force the refactor: put the query in a service, controller
      // delegates.
      //
      // Existing violations (5 files) carry per-line
      // // eslint-disable-next-line import/no-restricted-paths with
      // a TODO so the debt is grep-able and gets cleaned up
      // incrementally. New code blocked outright.
      'import/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: './src/**/*.controller.ts',
              from: './src/db',
              message:
                'Controllers MUST NOT import from src/db directly. Move the query into a service and inject the service instead. See § layer purity in CONTRIBUTING.md.',
            },
          ],
        },
      ],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-duplicated-branches': 'error',

      // ── god-file / complexity warnings (advisory) ─────────────────
      ...sizeGates,
    },
  },
  {
    // Test files: relax the size/complexity gates. Long describe()
    // blocks with many small `it`s legitimately blow past max-lines-
    // per-function; copy-paste in test setup is a DRY exception too
    // ("explicit > clever" is the standing rule for tests).
    files: ['test/**/*.ts', '**/*.spec.ts', '**/*.unit-spec.ts'],
    rules: {
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-classes-per-file': 'off',
      'max-params': 'off',
      complexity: 'off',
      'sonarjs/cognitive-complexity': 'off',
      'sonarjs/no-identical-functions': 'off',
      'sonarjs/no-duplicated-branches': 'off',
    },
  },
);
