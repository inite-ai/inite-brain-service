import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';
import { JwksService } from './jwks.service';
import { BrainScope, AuthenticatedRequest, ApiKeyRecord } from './api-key.types';

const REQUIRED_SCOPES_KEY = 'requiredScopes';
export const RequireScopes = (...scopes: BrainScope[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);
  private readonly staticAllowed: boolean;

  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly jwks: JwksService,
    private readonly reflector: Reflector,
    config: ConfigService,
  ) {
    const env = config.get<string>('NODE_ENV', 'development');
    // In production with JWKS configured, static keys are off — operators
    // must issue tokens through the auth-service. Everywhere else (dev,
    // test, JWKS not configured) static keys are accepted as a fallback.
    this.staticAllowed = !(env === 'production' && this.jwks.enabled());
    if (!this.staticAllowed) {
      this.logger.log(
        'Static BRAIN_API_KEYS disabled in production with JWKS enabled — JWT only',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers['authorization'] as string | undefined;

    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = header.slice(7).trim();
    let record: ApiKeyRecord | null = null;

    if (this.jwks.enabled() && JWT_SHAPE.test(token)) {
      record = await this.jwks.verify(token);
    }
    if (!record && this.staticAllowed) {
      record = this.apiKeys.resolve(token);
    }
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

    (request as AuthenticatedRequest).brainAuth = {
      companyId: record.companyId,
      scopes: record.scopes,
      keyHash: record.keyHash,
    };
    return true;
  }
}
