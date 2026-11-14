/**
 * Model source per tenant (#945 phase 2): who pays for a tenant's
 * server-side chat calls, the refusal before the network, the synthesize
 * notice, and the entitlements remembered for background work.
 */
import { HarnessModeRefusal } from '../src/common/extraction-source';
import {
  harnessServesTenant,
  noteTenantModelState,
  observedRefusals,
  platformEntitlements,
  PlatformModelsNotIncluded,
  resetTenantModelState,
  resolveModelSource,
  serverModelsRefused,
  tenantModelState,
} from '../src/common/model-source';
import { runWithTenant } from '../src/common/tenant-context';
import { withUsageLedger } from '../src/ai/llm-usage-ledger';
import { classifyProviderFailure } from '../src/ai/provider-failure';
import { serverModelsStatus } from '../src/ai/provider-health';
import { generatorFailureResult } from '../src/synthesize/model-unavailable';
import { TenantRegistryService } from '../src/auth/tenant-registry.service';
import type { SurrealService } from '../src/db/surreal.service';
import { ModelSourceResponseSchema } from '../src/contracts/admin/model-source.schema';
import { ServerModelsNoticeSchema } from '../src/contracts/common/server-models-notice.schema';

const ENFORCE = { MODEL_PLATFORM_GATE: 'enforce' } as NodeJS.ProcessEnv;

describe('model source per tenant', () => {
  beforeEach(() => resetTenantModelState());

  describe('resolveModelSource', () => {
    it('a tenant holding a paid entitlement uses platform models', () => {
      noteTenantModelState('acme', { entitlements: ['plan:pro'] });
      expect(resolveModelSource('acme', ENFORCE)).toEqual({
        source: 'platform',
        reason: 'entitled',
      });
    });

    it('a tenant without one is not included', () => {
      noteTenantModelState('acme', { entitlements: ['plan:free'] });
      expect(resolveModelSource('acme', ENFORCE)).toEqual({
        source: 'not_included',
        reason: 'not_entitled',
      });
    });

    it('a tenant never seen with a user token behaves as free', () => {
      expect(resolveModelSource('ghost', ENFORCE)).toEqual({
        source: 'not_included',
        reason: 'unknown_tenant',
      });
    });

    it("the tenant's harness setting wins over a paid plan", () => {
      noteTenantModelState('acme', { entitlements: ['plan:team'], setting: 'harness' });
      expect(resolveModelSource('acme', ENFORCE).source).toBe('harness');
    });

    it("the operator's platform override serves a tenant with no plan", () => {
      noteTenantModelState('s2s', { setting: 'platform' });
      expect(resolveModelSource('s2s', ENFORCE)).toEqual({
        source: 'platform',
        reason: 'operator_platform',
      });
    });

    it('EXTRACTION_SOURCE=harness overrides every tenant', () => {
      noteTenantModelState('acme', { entitlements: ['plan:pro'], setting: 'platform' });
      const env = { ...ENFORCE, EXTRACTION_SOURCE: 'harness' } as NodeJS.ProcessEnv;
      expect(resolveModelSource('acme', env)).toEqual({
        source: 'harness',
        reason: 'server_harness',
      });
    });

    it('the paid set is configured, and * includes everyone', () => {
      const env = { ...ENFORCE, MODEL_PLATFORM_ENTITLEMENTS: ' plan:gold , ' } as NodeJS.ProcessEnv;
      expect([...platformEntitlements(env)]).toEqual(['plan:gold']);
      expect([...platformEntitlements({} as NodeJS.ProcessEnv)]).toEqual(['plan:pro', 'plan:team']);
      noteTenantModelState('acme', { entitlements: ['plan:gold'] });
      expect(resolveModelSource('acme', env).source).toBe('platform');
      const all = { ...ENFORCE, MODEL_PLATFORM_ENTITLEMENTS: '*' } as NodeJS.ProcessEnv;
      expect(resolveModelSource('ghost', all).source).toBe('platform');
    });

    it('observe (the default) refuses nothing', () => {
      expect(resolveModelSource('ghost', {} as NodeJS.ProcessEnv)).toEqual({
        source: 'platform',
        reason: 'gate_observe',
      });
    });

    it('work outside any tenant is not gated', () => {
      expect(resolveModelSource(undefined, ENFORCE).source).toBe('platform');
      expect(serverModelsRefused(ENFORCE)).toBe(false);
    });

    it('a free tenant inside its tenant context is refused and served by the harness queue', () => {
      expect(runWithTenant('ghost', () => serverModelsRefused(ENFORCE))).toBe(true);
      expect(harnessServesTenant('ghost', ENFORCE)).toBe(true);
      noteTenantModelState('acme', { entitlements: ['plan:pro'] });
      expect(harnessServesTenant('acme', ENFORCE)).toBe(false);
    });
  });

  describe('the chat router refusal', () => {
    const prev = process.env.MODEL_PLATFORM_GATE;
    beforeEach(() => {
      process.env.MODEL_PLATFORM_GATE = 'enforce';
    });
    afterAll(() => {
      if (prev === undefined) delete process.env.MODEL_PLATFORM_GATE;
      else process.env.MODEL_PLATFORM_GATE = prev;
    });

    function fakeClient() {
      const chatCreate = jest.fn().mockResolvedValue({ usage: { prompt_tokens: 1 } });
      const embedCreate = jest.fn().mockResolvedValue({ usage: { prompt_tokens: 1 } });
      const client = {
        chat: { completions: { create: chatCreate } },
        embeddings: { create: embedCreate },
      };
      withUsageLedger(client, () => 0);
      return { client, chatCreate, embedCreate };
    }

    it('refuses a free tenant before any network call; embeddings still go out', async () => {
      const { client, chatCreate, embedCreate } = fakeClient();
      await runWithTenant('ghost', async () => {
        const err = await client.chat.completions.create({ model: 'm' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PlatformModelsNotIncluded);
        expect(err).toBeInstanceOf(HarnessModeRefusal);
        expect((err as PlatformModelsNotIncluded).code).toBe('platform_models_not_included');
        expect((err as PlatformModelsNotIncluded).status).toBe(403);
        await client.embeddings.create({ model: 'e' });
      });
      expect(chatCreate).not.toHaveBeenCalled();
      expect(embedCreate).toHaveBeenCalledTimes(1);
    });

    it('lets a paid tenant through', async () => {
      const { client, chatCreate } = fakeClient();
      noteTenantModelState('acme', { entitlements: ['plan:team'] });
      await runWithTenant('acme', () => client.chat.completions.create({ model: 'm' }));
      expect(chatCreate).toHaveBeenCalledTimes(1);
    });

    it('in observe, the call goes out and is counted', async () => {
      process.env.MODEL_PLATFORM_GATE = 'observe';
      const { client, chatCreate } = fakeClient();
      await runWithTenant('ghost', () => client.chat.completions.create({ model: 'm' }));
      expect(chatCreate).toHaveBeenCalledTimes(1);
      expect(observedRefusals('ghost')).toBe(1);
    });

    it('is classified as the server declining, not a bad key', () => {
      expect(classifyProviderFailure(new PlatformModelsNotIncluded())).toBe('harness');
    });
  });

  describe('synthesize and status', () => {
    it('synthesize answers model_unavailable with the plan notice and keeps the evidence', () => {
      const countSynthesize = jest.fn();
      const out = generatorFailureResult(
        { metrics: { countSynthesize }, logger: { warn: jest.fn() } },
        { err: new PlatformModelsNotIncluded(), guardrails: 'lenient', results: [] },
      );
      expect(out.reason).toBe('model_unavailable');
      expect(out.answer).toBeNull();
      expect(out.degraded).toEqual(['generator']);
      expect(out.notice?.code).toBe('platform_models_not_included');
      expect(out.notice?.message).toContain('Your plan does not include server-side models');
      expect(ServerModelsNoticeSchema.parse(out.notice)).toEqual(out.notice);
      expect(countSynthesize).toHaveBeenCalledWith('model_unavailable');
    });

    it('status carries the source and its reason', () => {
      const prev = process.env.MODEL_PLATFORM_GATE;
      process.env.MODEL_PLATFORM_GATE = 'enforce';
      try {
        const free = serverModelsStatus('ghost');
        expect(free.source).toBe('not_included');
        expect(free.sourceReason).toBe('unknown_tenant');
        expect(free.notice?.code).toBe('platform_models_not_included');
        expect(serverModelsStatus().source).toBe('platform');
      } finally {
        if (prev === undefined) delete process.env.MODEL_PLATFORM_GATE;
        else process.env.MODEL_PLATFORM_GATE = prev;
      }
    });

    it('the admin response contract accepts every resolution', () => {
      expect(() =>
        ModelSourceResponseSchema.parse({
          companyId: 'acme',
          modelSource: 'platform',
          source: 'platform',
          reason: 'operator_platform',
          gate: 'observe',
          entitlementsSeen: false,
          observedRefusals: 0,
        }),
      ).not.toThrow();
    });
  });

  describe('persisted entitlements', () => {
    function registry() {
      const query = jest.fn().mockResolvedValue([[]]);
      const surreal = {
        withAdminDb: (fn: (db: { query: typeof query }) => Promise<unknown>) => fn({ query }),
      } as unknown as SurrealService;
      return { reg: new TenantRegistryService(surreal), query };
    }

    it('writes the row only when the entitlements change', async () => {
      const { reg, query } = registry();
      reg.noteEntitlements('acme', ['plan:pro']);
      reg.noteEntitlements('acme', ['plan:pro']);
      await new Promise((r) => setImmediate(r));
      expect(query).toHaveBeenCalledTimes(1);
      expect(String(query.mock.calls[0]?.[0])).toContain('modelEntitlements = $list');
      expect(query.mock.calls[0]?.[1]).toEqual({ companyId: 'acme', list: ['plan:pro'] });
      expect(tenantModelState('acme')?.entitlements).toEqual(['plan:pro']);
      reg.noteEntitlements('acme', []);
      await new Promise((r) => setImmediate(r));
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('stores the tenant setting and the resolver reads it', async () => {
      const { reg, query } = registry();
      await reg.setModelSource('acme', 'harness');
      expect(String(query.mock.calls[0]?.[0])).toContain('modelSource = $setting');
      expect(resolveModelSource('acme', ENFORCE).source).toBe('harness');
    });
  });
});
