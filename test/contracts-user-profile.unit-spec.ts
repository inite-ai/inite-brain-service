/**
 * Wire-contract drift guard for GET /v1/users/:userId/profile.
 *
 * A fully-populated sample typed against the service wire interfaces
 * (compile-time parity) is parsed against the zod contract (runtime
 * parity) and pinned key-for-key.
 */
import {
  ProfileFactSchema,
  ProfileSectionSchema,
  UserProfileResponseSchema,
} from '../src/contracts/users/user-profile.schema';
import type {
  ProfileFactWire,
  ProfileSectionWire,
  UserProfileWire,
} from '../src/users/dto/user-profile.dto';

const fullFact: Required<ProfileFactWire> = {
  factId: 'knowledge_fact:abc',
  statement: 'Prefers morning meetings',
  validFrom: '2026-08-01T00:00:00.000Z',
  confidence: 0.85,
  lastSeenAt: '2026-08-15T00:00:00.000Z',
  kind: 'persona_attr',
};

const fullSection: ProfileSectionWire = {
  aspect: 'preferences',
  facts: [fullFact],
};

const fullProfile: UserProfileWire = {
  userId: 'user-1',
  generatedAt: '2026-08-21T00:00:00.000Z',
  factCount: 1,
  sections: [fullSection],
  profileText: '- [preferences] Prefers morning meetings (as of 2026-08-01)',
};

describe('user-profile wire contract', () => {
  it('UserProfileResponseSchema parses a fully-populated service result', () => {
    const parsed = UserProfileResponseSchema.safeParse(fullProfile);
    expect(parsed.success).toBe(true);
  });

  it('covers every field — both directions, all nesting levels', () => {
    expect(Object.keys(UserProfileResponseSchema.shape).sort()).toEqual(
      Object.keys(fullProfile).sort(),
    );
    expect(Object.keys(ProfileSectionSchema.shape).sort()).toEqual(Object.keys(fullSection).sort());
    expect(Object.keys(ProfileFactSchema.shape).sort()).toEqual(Object.keys(fullFact).sort());
  });
});
