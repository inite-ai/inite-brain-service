import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import type { AuthenticatedRequest } from '../auth/api-key.types';
import { ConfigInspectorService } from './config-inspector.service';
import { PlatformSettingsService } from './platform-settings.service';
import { SettingRefused } from '../common/platform-settings';
import { credentialCipherReady } from '../common/secret-cipher';
import {
  ConfigSetRequestSchema,
  type ConfigResponse,
  type ConfigWriteResponse,
} from '../contracts/admin/config.schema';

/**
 * The operator's configuration.
 *
 *   GET    /v1/admin/config        — every catalogued knob, with the value
 *                                    in force and whether an override
 *                                    stands over the deploy's own
 *   PUT    /v1/admin/config/:key   — set that override
 *   DELETE /v1/admin/config/:key   — drop it; the deploy's value stands
 *
 * Its own controller rather than another corner of admin-ops: this is the
 * one admin surface that changes what the service IS, and it deserves to
 * be read on its own.
 */
@Controller('v1/admin')
@UseGuards(ApiKeyGuard)
export class AdminConfigController {
  constructor(
    private readonly config: ConfigInspectorService,
    private readonly settings: PlatformSettingsService,
  ) {}

  @Get('config')
  @RequireScopes('brain:admin')
  async configList(): Promise<ConfigResponse> {
    const overrides = new Map((await this.settings.rows()).map((r) => [r.key, r]));
    return {
      entries: this.config.list(overrides),
      secretsWritable: credentialCipherReady(),
    } satisfies ConfigResponse;
  }

  /**
   * Set an override.
   *
   * `brain:admin`, the same scope the read already takes, and deliberately
   * NOT `brain:platform_admin`: that one is hosting-operator only and never
   * mintable through a token (api-key.types.ts), while the admin panel
   * authenticates with exactly such a token — requiring it would mean the
   * panel could never write, which is the whole point of the surface. The
   * fences that do the work instead: only a catalogued key can be written,
   * the bootstrap keys are refused (SETTINGS_ENV_ONLY), a secret is stored
   * encrypted and never read back, and every call lands in the
   * operator_action audit with the writer stamped on the row.
   */
  @Put('config/:key')
  @RequireScopes('brain:admin')
  async configSet(
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConfigWriteResponse> {
    const parsed = ConfigSetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid body');
    }
    try {
      const restartRequired = await this.settings.set({
        key,
        value: parsed.data.value,
        actor: actorOf(req),
        note: parsed.data.note,
      });
      return { key, outcome: 'set', restartRequired } satisfies ConfigWriteResponse;
    } catch (e) {
      if (e instanceof SettingRefused) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Drop an override; the value the deploy itself set stands again. */
  @Delete('config/:key')
  @RequireScopes('brain:admin')
  async configClear(
    @Param('key') key: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ConfigWriteResponse> {
    const cleared = await this.settings.clear(key, actorOf(req));
    return {
      key,
      outcome: cleared ? 'cleared' : 'absent',
      restartRequired: cleared && !this.settings.runtimeMutable(key),
    } satisfies ConfigWriteResponse;
  }
}

/** Who to stamp on the row: the end user when the token names one, else the credential. */
function actorOf(req: AuthenticatedRequest): string {
  return req.brainAuth.userId ?? req.brainAuth.actorId ?? req.brainAuth.companyId;
}
