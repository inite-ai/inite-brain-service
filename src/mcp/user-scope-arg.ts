import { z } from 'zod';

/**
 * The per-user scope argument every read tool takes. A user-bound token
 * is pinned to its own user whether or not it passes one.
 */
export const userScopeArg = z
  .string()
  .max(200)
  .optional()
  .describe(
    "Per-user memory scope: results include tenant-global facts plus this user's personal ones; omit for tenant-global only (fail-closed)",
  );
