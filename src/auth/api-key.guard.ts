import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CredentialResolverService } from './credential-resolver.service';
import { BrainScope, AuthenticatedRequest, ApiKeyRecord } from './api-key.types';

const REQUIRED_SCOPES_KEY = 'requiredScopes';
export const RequireScopes = (...scopes: BrainScope[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, scopes);

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly credentials: CredentialResolverService,
    private readonly reflector: Reflector,
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

    (request as AuthenticatedRequest).brainAuth = {
      companyId: record.companyId,
      scopes: record.scopes,
      keyHash: record.keyHash,
    };
    return true;
  }
}
