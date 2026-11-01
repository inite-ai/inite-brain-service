// Mutation testing of the tenancy and scope fences (ground rule 2), run by
// `pnpm test:mutation`. The specs under test are the ones that import a
// mutated module, found by reading the test files — so a new fence test
// is picked up without editing this file.
import { readdirSync, readFileSync } from 'node:fs';

const mutate = [
  'src/auth/scope-visibility.ts',
  'src/auth/user-scope.ts',
  'src/auth/tenant-scope.ts',
  'src/search/internals/where-builder.ts',
];

const importPaths = mutate.map((f) => f.replace(/^src\//, '').replace(/\.ts$/, ''));
const specs = readdirSync('test')
  .filter((f) => f.endsWith('.unit-spec.ts'))
  .filter((f) => {
    const text = readFileSync(`test/${f}`, 'utf8');
    return importPaths.some((p) => text.includes(`/src/${p}'`));
  });
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'pnpm',
  plugins: ['@stryker-mutator/jest-runner'],
  testRunner: 'jest',
  testRunnerNodeArgs: ['--experimental-vm-modules', '--no-warnings'],
  jest: {
    configFile: 'test/jest-unit.json',
    enableFindRelatedTests: true,
    config: {
      testRegex: `test/(${specs.map(escape).join('|')})$`,
      testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
      modulePathIgnorePatterns: ['<rootDir>/.claude/'],
    },
  },
  mutate,
  ignorePatterns: ['.claude', 'brain-landing', 'dist', 'coverage', 'reports', 'clients', 'plugins'],
  coverageAnalysis: 'perTest',
  concurrency: 2,
  timeoutMS: 60000,
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  // The ratchet: the score reached when the gaps were closed (97.79%, the five
  // survivors equivalent mutants). A fence change the tests stop noticing
  // fails the run.
  thresholds: { high: 95, low: 90, break: 97 },
};
