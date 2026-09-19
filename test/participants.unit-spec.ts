/**
 * The user among a turn's participants (src/ingest/participants.ts +
 * src/ingest/user-entity.ts):
 *  - a user-scoped mention with no declared speaker gets the user as
 *    its speaker, anchored on the user's own reference, named as far as
 *    the name is known (the userId stands in otherwise);
 *  - a declared speaker always wins — someone else's words relayed
 *    under the user's scope are never re-attributed;
 *  - the user's own reference anchored without a name gets the name;
 *  - the coreference rule is one rule for both ingest paths;
 *  - the hint of the user's own reference carries the user's scope, so
 *    the entity is minted under the scoped key — the same key a typed
 *    fact on {vertical: 'user', id} lands on.
 */
import type { IngestMentionDto } from '../src/ingest/dto/ingest-mention.dto';
import {
  coreferentParticipant,
  participantHint,
  participantsOf,
  withUserAsSpeaker,
} from '../src/ingest/participants';
import { isUserEntityRef, userEntityKey, userEntityRef } from '../src/ingest/user-entity';
import { scopedRefKey } from '../src/ingest/ingest-utils';

const turn = (over: Partial<IngestMentionDto> = {}): IngestMentionDto =>
  ({
    text: 'I listed my apartment in Riga for sale today.',
    contextRef: { vertical: 'personal', conversationId: 'c1' },
    emittedAt: '2026-08-07T14:00:00.000Z',
    ...over,
  }) as IngestMentionDto;

describe('the user as the speaker', () => {
  it('a user-scoped turn with no speaker anchor is spoken by the user, under their own reference', () => {
    const dto = withUserAsSpeaker(turn({ userId: 'u42' }), 'Sasha');
    const { speaker } = participantsOf(dto);
    expect(speaker).toEqual({ vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' });
    expect(isUserEntityRef(speaker, 'u42')).toBe(true);
  });

  it('the userId stands in for the name until one is known', () => {
    const { speaker } = participantsOf(withUserAsSpeaker(turn({ userId: 'u42' }), undefined));
    expect(speaker?.name).toBe('u42');
  });

  it('without a userId there is no user and the turn is left alone', () => {
    const dto = turn();
    expect(withUserAsSpeaker(dto, 'Sasha')).toBe(dto);
  });

  it('a declared speaker wins — relayed words under the user scope stay theirs', () => {
    const dto = turn({
      userId: 'operator-7',
      knownEntities: [{ vertical: 'crm', id: 'ana', role: 'speaker', name: 'Ana' }],
    });
    expect(withUserAsSpeaker(dto, 'Mike')).toBe(dto);
    expect(participantsOf(dto).speaker?.name).toBe('Ana');
  });

  it("the user's own reference anchored without a name gets the name; a named one is kept", () => {
    const unnamed = turn({
      userId: 'u42',
      knownEntities: [{ vertical: 'user', id: 'u42', role: 'speaker' }],
    });
    expect(participantsOf(withUserAsSpeaker(unnamed, 'Sasha')).speaker?.name).toBe('Sasha');
    const named = turn({
      userId: 'u42',
      knownEntities: [{ vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' }],
    });
    expect(withUserAsSpeaker(named, 'Other')).toBe(named);
  });

  it('other anchors are kept behind the user', () => {
    const dto = withUserAsSpeaker(
      turn({
        userId: 'u42',
        knownEntities: [{ vertical: 'personal', id: 'boris', name: 'Boris' }],
      }),
      'Sasha',
    );
    expect(dto.knownEntities?.map((k) => k.id)).toEqual(['u42', 'boris']);
  });
});

describe('the coreference rule', () => {
  const participants = participantsOf({
    knownEntities: [
      { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' },
      { vertical: 'personal', id: 'boris', role: 'addressee', name: 'Boris' },
    ],
  });

  it('first person and the speaker name → the speaker; second person and the addressee name → the addressee', () => {
    expect(coreferentParticipant('I', participants)?.id).toBe('u42');
    expect(coreferentParticipant('sasha', participants)?.id).toBe('u42');
    expect(coreferentParticipant('you', participants)?.id).toBe('boris');
    expect(coreferentParticipant('Boris', participants)?.id).toBe('boris');
    expect(coreferentParticipant('Riga', participants)).toBeUndefined();
    expect(coreferentParticipant('we', participants)).toBeUndefined();
  });
});

describe('the participant hint', () => {
  it("the user's own reference carries the user's scope; any other reference does not", () => {
    const own = participantHint(
      { vertical: 'user', id: 'u42', role: 'speaker', name: 'Sasha' },
      'u42',
    );
    expect(own).toEqual({
      vertical: 'user',
      id: 'u42',
      role: 'speaker',
      name: 'Sasha',
      userId: 'u42',
    });
    const other = participantHint({ vertical: 'user', id: 'u42', role: 'speaker' }, 'u43');
    expect(other?.userId).toBeUndefined();
    expect(
      participantHint({ vertical: 'crm', id: 'ana', role: 'speaker' }, 'u42')?.userId,
    ).toBeUndefined();
    expect(participantHint(undefined, 'u42')).toBeUndefined();
  });

  it("the user's key is the scoped key of their reference — the typed fact path's key for the same ref", () => {
    const ref = userEntityRef('u42');
    expect(userEntityKey('u42')).toBe(scopedRefKey(ref.vertical, ref.id, 'u42'));
    expect(userEntityKey('u42')).toBe('user__u42::u::u42');
    // No scope → the plain tenant-global key; a dotted id cannot forge the marker.
    expect(scopedRefKey('x', 'u.bob', undefined)).toBe('x__u__bob');
    expect(scopedRefKey('x', 'u.bob', 'bob')).toBe('x__u__bob::u::bob');
  });
});
