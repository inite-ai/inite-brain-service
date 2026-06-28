import { Injectable } from '@nestjs/common';
import type { BrainScope } from '../auth/api-key.types';
import { ChatRouterService, ChatRoute } from './chat-router.service';
import { DemoPipelineService } from './demo-pipeline.service';
import { DemoStateService } from './demo-state.service';

/**
 * DemoChatService — chat-shaped one-shot orchestration for the live-demo
 * sandbox. Resolves known entity names (DemoStateService), routes the
 * message (ChatRouterService) into tell-vs-ask, and runs the matching
 * brain pipeline (DemoPipelineService). Returns the raw result; the
 * controller owns debug-trace capture, response shaping, and upstream-LLM
 * error classification. Three deps keeps it under the gate.
 */
@Injectable()
export class DemoChatService {
  constructor(
    private readonly chatRouter: ChatRouterService,
    private readonly pipeline: DemoPipelineService,
    private readonly state: DemoStateService,
  ) {}

  async chat({
    message,
    tenant,
    scopes,
  }: {
    message: string;
    tenant: string;
    scopes: readonly BrainScope[];
  }) {
    const knownNames = await this.state.fetchKnownEntityNames(tenant);
    const route: ChatRoute = await this.chatRouter.route(message, {
      knownNames,
      companyId: tenant,
    });
    if (route.intent === 'tell') {
      return this.pipeline.runTell(route, tenant);
    }
    return this.pipeline.runAsk({ route, message, tenant, scopes });
  }
}
