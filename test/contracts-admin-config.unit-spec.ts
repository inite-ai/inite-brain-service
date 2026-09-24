/**
 * Wire-contract drift guard for GET /v1/admin/config.
 */
import { ConfigResponseSchema } from '../src/contracts/admin/config.schema';
import { AdminConfigController } from '../src/admin/admin-config.controller';
import type { ConfigInspectorService } from '../src/admin/config-inspector.service';
import type { PlatformSettingsService } from '../src/admin/platform-settings.service';

function makeController(): AdminConfigController {
  const config = {
    list: () => [
      {
        key: 'OPENAI_API_KEY',
        category: 'auth' as const,
        currentValue: '∅',
        defaultValue: null,
        runtimeMutable: false,
        isBooleanFlag: false,
        description: 'OpenAI API key',
        secret: true,
        overridden: false,
        settable: true,
      },
      {
        key: 'EMBEDDER_PROVIDER',
        category: 'embedder' as const,
        currentValue: 'bge-m3',
        defaultValue: 'bge-m3',
        runtimeMutable: false,
        isBooleanFlag: false,
        overridden: true,
        deployValue: 'openai',
        settable: true,
        updatedAt: '2026-09-24T10:00:00.000Z',
        updatedBy: 'ops@inite',
        note: null,
      },
    ],
  } as unknown as ConfigInspectorService;
  const settings = {
    rows: async () => [],
  } as unknown as PlatformSettingsService;
  return new AdminConfigController(config, settings);
}

describe('AdminConfigController.configList() — wire contract', () => {
  it('matches ConfigResponseSchema', async () => {
    const parsed = ConfigResponseSchema.safeParse(await makeController().configList());
    if (!parsed.success) {
      throw new Error(`config drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
  });
});
