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
        // Type-aware linting is ON: the promise-safety rules
        // (no-floating-promises / no-misused-promises / await-thenable)
        // need the type-checker.
        //
        // We use the explicit `project` array rather than the newer
        // `projectService: true`. projectService resolves each file to its
        // NEAREST tsconfig.json — which for test/ files is the root
        // tsconfig.json, and that config *excludes* test/. The service then
        // refuses every spec with "not found by the project service". The
        // two-config array below is the documented fallback: tsconfig.json
        // covers src/, tsconfig.spec.json covers src/ + test/.
        project: ['./tsconfig.json', './tsconfig.spec.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.ts', '.js'] },
      },
    },
    rules: {
      // Production code is typed — no `any` escape hatch. SurrealDB
      // query results go through the generic `queryRows<T>` / typed
      // `db.query<[Row[]]>()` idiom (see src/db/surreal.service.ts);
      // genuinely-dynamic payloads use `unknown` + narrowing. The
      // handful of unavoidable spots carry a per-line disable with a
      // reason. Tests keep `any` for mocks/fixtures (override below).
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-const': 'warn',

      // ── Promise-safety (type-aware) ───────────────────────────────
      // An unawaited async call is a real bug class: fire-and-forget DB
      // writes, unhandled rejections that crash the process on an
      // unrelated tick. These need the type-checker (projectService,
      // above). `require-await` is deliberately NOT enabled — it flags
      // intentionally-async interface impls and is too noisy.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'prettier/prettier': 'off', // formatting gated by the CI `format:check` step, not lint

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

      // ── god-file / complexity budgets ─────────────────────────────
      // All 'error' — with lint:ci running `--max-warnings 0` these are
      // hard, merge-blocking gates, not advisory warnings.
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
      // Mocks/fixtures legitimately use `any` (partial stubs, cast doubles);
      // typing them precisely is low-value churn. Kept ON for src only.
      '@typescript-eslint/no-explicit-any': 'off',
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
  {
    // The two real-e2e specs below genuinely exercise the `@inite/knowledge`
    // SDK that lives in the sibling ../inite-shared repo, which is NOT
    // checked out in the build-test gate. tsconfig.spec.json therefore
    // *excludes* them (see its comment), so the type-aware parser has no
    // program for them — `project` would throw "not found by the project".
    // Drop them to a non-type-aware parse and switch the type-aware rules
    // off here (they can't run without a program). Everything else still
    // lints. This mirrors the tsconfig.spec.json exclusion 1:1.
    files: ['test/brain.real-e2e-spec.ts', 'test/dreams.real-e2e-spec.ts'],
    languageOptions: {
      parserOptions: { project: false, projectService: false },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/await-thenable': 'off',
    },
  },
);
