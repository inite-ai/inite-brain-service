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
    "Whose memory: this user's personal facts beside the tenant-global ones; omit for tenant-global only",
  );
