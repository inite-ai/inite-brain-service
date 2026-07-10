import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CredentialResolverService } from './credential-resolver.service';
import { PolicyGateService } from '../policy/policy-gate.service';
import { POLICY_ACTION_KEY } from '../policy/action-registry';
import { getRequestContext } from '../common/request-context';
import { BrainScope, AuthenticatedRequest, ApiKeyRecord } from './api-key.types';

const REQUIRED_SCOPES_KEY = 'requiredScopes';
export const RequireScopes = (...scopes: BrainScope[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly credentials: CredentialResolverService,
    private readonly reflector: Reflector,
    private readonly policyGate: PolicyGateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'] as string | undefined;

    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = header.slice(7).trim();
    const record: ApiKeyRecord | null = await this.credentials.resolve(token);
    if (!record) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const required =
      this.reflector.getAllAndOverride<BrainScope[]>(REQUIRED_SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    for (const s of required) {
      if (!record.scopes.includes(s)) {
        throw new ForbiddenException(`Scope ${s} required`);
      }
    }

    // ABAC action gate, after the scope gate. Decorated handlers carry
    // an action name; undecorated ones fall back to "<METHOD> <path>"
    // so a default-deny policy has no unnamed holes. Throws 403
    // policy_denied on an enforced deny; resolves to undefined when the
    // key carries no policies (pre-ABAC behavior).
    const action =
      this.reflector.getAllAndOverride<string>(POLICY_ACTION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? `${request.method} ${request.route?.path ?? request.url}`;
    const policy = await this.policyGate.gate(
      record,
      action,
      request.id ?? request.headers['x-request-id'],
    );

    // Stamp the context into AsyncLocalStorage so read surfaces deep in
    // the pipeline (search fusion, graph_retrieve, competing facts,
    // entity reads) row-filter without signature threading. The
    // recorder closure gives the pure row-filter module a path to the
    // decision sink + metrics without DI.
    if (policy) {
      const store = getRequestContext();
      if (store) {
        store.policy = policy;
        store.recordPolicyRows = (summary) =>
          this.policyGate.recordRowSummary(policy, summary);
      } else {
        // Deliberately loud: without the correlation middleware's ALS
        // store the row-level gate is inactive (action gate above still
        // enforced). This only happens on a mis-wired bootstrap — every
        // real entrypoint mounts correlationIdMiddleware before routing.
        this.logger.warn(
          'Request context missing — ABAC row-level filtering inactive for this request',
        );
      }
    }

    (request as AuthenticatedRequest).brainAuth = {
      companyId: record.companyId,
      scopes: record.scopes,
      keyHash: record.keyHash,
      ...(policy ? { policy } : {}),
    };
    return true;
  }
}
