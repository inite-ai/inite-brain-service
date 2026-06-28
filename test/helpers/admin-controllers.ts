/**
 * Named-dependency builders for the admin controllers' wire-contract unit
 * specs.
 *
 * The controllers are constructor-injected with many collaborators, but a
 * given contract spec only stubs the one or two it actually calls. Passing
 * a long run of positional `undefined`s was brittle (every constructor
 * change shifted every spec's argument list) and unreadable. These helpers
 * take the deps BY NAME and fill the rest with undefined, so a spec writes
 * `makeAdminController({ reindex })` and constructor changes touch only
 * this file.
 */
import { AdminController } from '../../src/admin/admin.controller';
import { AdminInfraController } from '../../src/admin/admin-infra.controller';

const u = undefined as never;
const as = <T>(v: unknown): T => v as T;

export interface AdminControllerDeps {
  admin?: unknown;
  dreams?: unknown;
  routeCache?: unknown;
  collapsePatterns?: unknown;
  intentClassifier?: unknown;
  embedder?: unknown;
  reindex?: unknown;
  calibration?: unknown;
  calibrationRefit?: unknown;
}

export function makeAdminController(d: AdminControllerDeps = {}): AdminController {
  return new AdminController(
    as(d.admin ?? u),
    as(d.dreams ?? u),
    as(d.routeCache ?? u),
    as(d.collapsePatterns ?? u),
    as(d.intentClassifier ?? u),
    as(d.embedder ?? u),
    as(d.reindex ?? u),
    as(d.calibration ?? u),
    as(d.calibrationRefit ?? u),
  );
}

export interface AdminInfraControllerDeps {
  adminInfra?: unknown;
  healthComponents?: unknown;
  liveSnapshot?: unknown;
}

export function makeAdminInfraController(
  d: AdminInfraControllerDeps = {},
): AdminInfraController {
  return new AdminInfraController(
    as(d.adminInfra ?? u),
    as(d.healthComponents ?? u),
    as(d.liveSnapshot ?? u),
  );
}
