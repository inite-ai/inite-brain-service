import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NOT_IN_ANY_PIPELINE,
  PIPELINES,
  pipelineValue,
  resolvePipeline,
} from '../src/config/pipelines';
import { CONFIG_CATALOG } from '../src/admin/config-catalog.data';

/**
 * THE ASSEMBLY GATE.
 *
 * A lane that belongs to no conveyor is dead weight, and until the
 * assembly lived in code there was no way to ask which lanes those were:
 * the shipped set was 152 loose `KEY=1` lines in a deploy YAML, so the
 * question was a grep and the answer went stale the moment anyone edited
 * either side.
 *
 * This is that question, asked mechanically and failing loudly. Every
 * boolean lane in the catalog is either IN a pipeline or NAMED in
 * NOT_IN_ANY_PIPELINE with a reason. Adding a lane and shipping it
 * nowhere now breaks a test instead of quietly joining the other
 * hundred-odd.
 */
describe('pipelines — the assembly gate', () => {
  const booleanKeys = CONFIG_CATALOG.filter((e) => e.isBooleanFlag === true).map((e) => e.key);

  const inSomePipeline = new Set<string>();
  for (const p of Object.values(PIPELINES)) {
    for (const key of Object.keys(p.settings)) inSomePipeline.add(key);
  }

  it('every catalog lane is either in a pipeline or explicitly out of all of them', () => {
    const orphans = booleanKeys.filter(
      (k) => !inSomePipeline.has(k) && !(k in NOT_IN_ANY_PIPELINE),
    );
    expect(orphans).toEqual([]);
  });

  it('nothing is both assembled and declared unassembled', () => {
    const both = Object.keys(NOT_IN_ANY_PIPELINE).filter((k) => inSomePipeline.has(k));
    expect(both).toEqual([]);
  });

  it('every unassembled lane gives a reason, and it says which kind', () => {
    for (const reason of Object.values(NOT_IN_ANY_PIPELINE)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(reason).toMatch(/^(operational|cut candidate|scene plane|live via)/);
    }
    expect(Object.keys(NOT_IN_ANY_PIPELINE).length).toBeGreaterThan(0);
  });

  it('every key a pipeline sets is a key the catalog knows', () => {
    const known = new Set(CONFIG_CATALOG.map((e) => e.key));
    const unknown: string[] = [];
    for (const p of Object.values(PIPELINES)) {
      for (const key of Object.keys(p.settings)) if (!known.has(key)) unknown.push(key);
    }
    expect([...new Set(unknown)]).toEqual([]);
  });
});

/**
 * `assistant-chat` is a transcription of what production already runs,
 * so selecting it must change nothing. This compares it against the
 * deploy workflow itself rather than against a copy of the list, because
 * a copy drifts and a comparison does not.
 */
describe('pipelines — assistant-chat matches the deploy workflow', () => {
  const workflow = readFileSync(
    join(__dirname, '..', '.github', 'workflows', 'deploy-brain.yml'),
    'utf8',
  );
  const deployed = new Map<string, string>();
  for (const m of workflow.matchAll(/^\s*(?:-\s*)?([A-Z][A-Z0-9_]+)=([^\s#]*)\s*$/gm)) {
    deployed.set(m[1]!, m[2]!);
  }
  const settings = PIPELINES['assistant-chat'].settings;
  const catalogKeys = new Set(CONFIG_CATALOG.map((e) => e.key));

  // envFlagEnabled treats '1' and 'true' alike, and the deploy uses both
  // spellings, so the comparison has to as well — reading only '1' is how
  // two live lanes nearly got filed as "off in production".
  const isOn = (v: string | undefined): boolean => v === '1' || v === 'true';

  it('turns on every lane the deploy turns on', () => {
    const missing = [...deployed.entries()]
      .filter(([k, v]) => isOn(v) && catalogKeys.has(k) && !isOn(settings[k]))
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it('the lanes it adds beyond the deploy are exactly the code-default-on ones', () => {
    const defaults = new Map(CONFIG_CATALOG.map((e) => [e.key, e.defaultValue]));
    const extra = Object.entries(settings)
      .filter(([k, v]) => isOn(v) && !isOn(deployed.get(k)))
      .map(([k]) => k);
    // Not a formality: these run in production because their CODE
    // default is on, so the deploy never names them and the YAML alone
    // does not describe what ships. They belong to the conveyor.
    const notDefaultOn = extra.filter((k) => defaults.get(k) !== '1');
    expect(notDefaultOn).toEqual([]);
  });

  it('carries the same value for every tuning key the deploy sets', () => {
    for (const [key, value] of deployed) {
      if (!catalogKeys.has(key)) continue; // infrastructure, not a lane
      if (value === '0') continue; // an explicit off is a code default
      expect(settings[key]).toBe(value);
    }
  });
});

describe('pipelines — resolution order', () => {
  it('an explicit env key beats the pipeline, so a kill-switch still kills', () => {
    const env = { BRAIN_PIPELINE: 'assistant-chat', FOVEA_LENS_SUPPRESS: '0' } as NodeJS.ProcessEnv;
    expect(PIPELINES['assistant-chat'].settings.FOVEA_LENS_SUPPRESS).toBe('1');
    expect(pipelineValue('FOVEA_LENS_SUPPRESS', env)).toBe('0');
  });

  it('the pipeline supplies what the operator did not', () => {
    const env = { BRAIN_PIPELINE: 'assistant-chat' } as NodeJS.ProcessEnv;
    expect(pipelineValue('FOVEA_LENS_SUPPRESS', env)).toBe('1');
  });

  it('no pipeline selected ⇒ undefined, and the caller keeps its code default', () => {
    expect(pipelineValue('FOVEA_LENS_SUPPRESS', {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(resolvePipeline({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('an unknown pipeline id resolves to nothing rather than to a guess', () => {
    const env = { BRAIN_PIPELINE: 'assistant_chat' } as NodeJS.ProcessEnv;
    expect(resolvePipeline(env)).toBeUndefined();
  });

  it('an empty env value is not an override — the pipeline still supplies it', () => {
    const env = {
      BRAIN_PIPELINE: 'assistant-chat',
      FOVEA_LENS_SUPPRESS: '  ',
    } as NodeJS.ProcessEnv;
    expect(pipelineValue('FOVEA_LENS_SUPPRESS', env)).toBe('1');
  });
});

describe('pipelines — multilingual is assistant-chat plus one chain', () => {
  it('contains everything the shipped conveyor contains', () => {
    const base = PIPELINES['assistant-chat'].settings;
    const ml = PIPELINES.multilingual.settings;
    for (const [k, v] of Object.entries(base)) expect(ml[k]).toBe(v);
  });

  it('adds the language chain and nothing else', () => {
    const base = new Set(Object.keys(PIPELINES['assistant-chat'].settings));
    const added = Object.keys(PIPELINES.multilingual.settings).filter((k) => !base.has(k));
    expect(added.every((k) => k.startsWith('MULTILINGUAL_'))).toBe(true);
    expect(added.length).toBeGreaterThan(1);
  });
});
