/**
 * Wire-contract drift guard for GET /v1/admin/config.
 */
import { ConfigResponseSchema } from '../src/contracts/admin/config.schema';
import { AdminOpsController } from '../src/admin/admin-ops.controller';
import type { ConfigInspectorService } from '../src/admin/config-inspector.service';

function makeController(): AdminOpsController {
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
      },
      {
        key: 'EMBEDDER_PROVIDER',
        category: 'embedder' as const,
        currentValue: 'bge-m3',
        defaultValue: 'bge-m3',
        runtimeMutable: false,
        isBooleanFlag: false,
      },
    ],
  } as unknown as ConfigInspectorService;
  const undef = undefined as unknown as never;
  return new AdminOpsController(undef, config, undef);
}

describe('AdminOpsController.configList() — wire contract', () => {
  it('matches ConfigResponseSchema', () => {
    const parsed = ConfigResponseSchema.safeParse(makeController().configList());
    if (!parsed.success) {
      throw new Error(
        `config drifted: ${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
  });
});
