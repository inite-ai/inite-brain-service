/**
 * The end user as an entity of their own memory.
 *
 * A request's `userId` is the identity key of the person the memory is
 * captured for (migration 0055 scopes their facts by it); this module
 * names the entity that stands for that person. It is an external
 * reference like any other — vertical `user`, id = the userId — in the
 * namespace the scope-tag grammar already reserves for end users
 * (`user:<id>`, scope-tags.ts), and it lives under the user's own scope:
 * a PERSONAL entity (userId stamped, `user:<id>` scope tag), visible to
 * the user and to nobody else, deleted with the user's memory on forget.
 * Both write paths mint it through the same scoped key, so a first-person
 * turn (`/v1/ingest/mention` with a userId) and a typed fact on
 * `{vertical: 'user', id: <userId>}` land on one node.
 *
 * Pure module — no NestJS, no DB.
 */
import { USER_NAMESPACE } from '../auth/scope-tags';
import { scopedRefKey } from './ingest-utils';

/** The vertical of the end users' own entities. */
export const USER_ENTITY_VERTICAL = USER_NAMESPACE;

/** The reference the user's own entity is filed under. */
export function userEntityRef(userId: string): { vertical: string; id: string } {
  return { vertical: USER_ENTITY_VERTICAL, id: userId };
}

/** Whether a (vertical, id) reference names the request's own user. */
export function isUserEntityRef(
  ref: { vertical: string; id: string } | undefined,
  userId: string | undefined,
): boolean {
  return (
    ref !== undefined &&
    userId !== undefined &&
    ref.vertical === USER_ENTITY_VERTICAL &&
    ref.id === userId
  );
}

/** The external-ref key of the user's own entity — the scoped form of its ref. */
export function userEntityKey(userId: string): string {
  return scopedRefKey(USER_ENTITY_VERTICAL, userId, userId);
}
