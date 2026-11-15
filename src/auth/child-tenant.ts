/**
 * Child tenants: one product machine client acting for many client
 * companies, each in a Brain tenant of its own (ADR
 * docs/adr/0001-child-tenants.md).
 *
 * A B2B family product (inite.rent: rental companies, inite.training:
 * clubs) holds ONE machine credential, whose tenant is its auth client's
 * companyId (`sub`). Each of its client companies must keep its memory in
 * its own tenant. A credential carrying `brain:tenants` may name a child
 * on each request with the `X-Brain-Child-Tenant` header; the request then
 * runs in the tenant `<parent>__<child>`.
 *
 * The namespace is DERIVED, never asserted: the parent half is always the
 * credential's own companyId, so product A can only ever reach
 * `A__*`, never `B__*`, whatever the header says. A child id may not
 * contain `_`, so it cannot smuggle a second separator, and no credential
 * whose own companyId contains `__` is accepted at all (the separator is
 * reserved: a token naming `A__x` directly would otherwise land in A's
 * child without A's authority). Children do not nest.
 *
 * Pure module: the guard and the erase service both use it.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { BrainScope } from './api-key.types';

export const CHILD_TENANT_SCOPE: BrainScope = 'brain:tenants';
export const CHILD_TENANT_HEADER = 'x-brain-child-tenant';
export const CHILD_TENANT_SEPARATOR = '__';
/** Lowercase letters, digits and dashes; starts alphanumeric; no `_`. */
const CHILD_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Every tenant id must still fit the companyId rule (claim-parsers.ts). */
const MAX_TENANT_ID = 64;

/** True for an id in the reserved child namespace. */
export function isChildTenantId(companyId: string): boolean {
  return companyId.includes(CHILD_TENANT_SEPARATOR);
}

/** `<parent>__<child>`, or a 400/403 when either half is not allowed. */
export function childTenantId(parent: string, child: string): string {
  if (isChildTenantId(parent)) {
    throw new ForbiddenException('a child tenant cannot have children of its own');
  }
  if (!CHILD_ID.test(child)) {
    throw new BadRequestException(
      'child tenant id must be 1-40 lowercase letters, digits or dashes, starting with a letter or digit',
    );
  }
  const id = `${parent}${CHILD_TENANT_SEPARATOR}${child}`;
  if (id.length > MAX_TENANT_ID) {
    throw new BadRequestException(`child tenant id is too long for parent ${parent}`);
  }
  return id;
}

export interface ChildTenantCredential {
  companyId: string;
  scopes: readonly BrainScope[];
  userId?: string | undefined;
}

/**
 * The tenant a request runs in, given its verified credential and the
 * child header (undefined when the header is absent: the caller's own
 * tenant, or whatever the platform override decides).
 *
 *  - a credential whose own companyId is in the reserved namespace: 403;
 *  - a child named without `brain:tenants`: 403;
 *  - a child named by a user-bound token: 403 (a product's backend acts
 *    for its client companies, not one end-user's token);
 *  - otherwise `<own companyId>__<child>`.
 */
export function resolveChildTenant(
  record: ChildTenantCredential,
  headers: Record<string, unknown> | undefined,
): string | undefined {
  if (isChildTenantId(record.companyId)) {
    throw new ForbiddenException(
      `tenant ids containing "${CHILD_TENANT_SEPARATOR}" are reserved for child tenants`,
    );
  }
  const raw = headers?.[CHILD_TENANT_HEADER];
  const child = (Array.isArray(raw) ? raw[0] : raw) as unknown;
  if (child === undefined || child === null || String(child).trim() === '') return undefined;
  if (!record.scopes.includes(CHILD_TENANT_SCOPE)) {
    throw new ForbiddenException(`Scope ${CHILD_TENANT_SCOPE} required to act for a child tenant`);
  }
  if (record.userId) {
    throw new ForbiddenException('a user-bound token cannot act for a child tenant');
  }
  return childTenantId(record.companyId, String(child).trim());
}
