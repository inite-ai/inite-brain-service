/**
 * The participants of one ingested turn, by role — and the end user
 * among them.
 *
 * A mention names its participants in `knownEntities` by role: the
 * `speaker` (first person resolves to them) and the `addressee` (second
 * person). A mention that carries a `userId` is memory captured FOR that
 * user — their side of a conversation with their assistant, their notes
 * — so when the caller declares no speaker, the user is the speaker: an
 * unattributed "I" in such a turn is theirs, and the entity it resolves
 * to is the user's own (user-entity.ts). A declared speaker always wins,
 * so a caller relaying someone else's words (a call transcript filed
 * under the operator's scope) says so and nothing is misattributed.
 *
 * Pure module — the lookups that name the user live in
 * UserEntityService; this file only decides shapes.
 */
import type { IngestMentionDto, KnownEntity } from './dto/ingest-mention.dto';
import {
  isFirstPersonSelfReference,
  isSecondPersonReference,
  matchesParticipantName,
} from '../common/coreference';
import { isUserEntityRef, userEntityRef } from './user-entity';

export interface Participants {
  speaker?: KnownEntity | undefined;
  addressee?: KnownEntity | undefined;
}

/** The turn's participants by role (the first anchor of each role). */
export function participantsOf(dto: Pick<IngestMentionDto, 'knownEntities'>): Participants {
  const speaker = dto.knownEntities?.find((k) => k.role === 'speaker');
  const addressee = dto.knownEntities?.find((k) => k.role === 'addressee');
  return {
    ...(speaker ? { speaker } : {}),
    ...(addressee ? { addressee } : {}),
  };
}

/**
 * A participant as the entity-resolution anchor (EntityUpsertService's
 * `hint`): the caller's external reference, its display name, and — for
 * the user's own reference — the user's scope, so the entity is minted
 * under the user's own key as a personal entity (0055) rather than as a
 * tenant-global node.
 */
export interface ParticipantHint {
  vertical: string;
  id: string;
  role?: string | undefined;
  name?: string | undefined;
  userId?: string | undefined;
}

/**
 * Which participant (if any) an extracted entity corefers to, so the
 * resolver anchors it to that participant's reference instead of minting
 * a pronoun or duplicate node:
 *   - first-person singular ("I", "me", "my") or the speaker's own name
 *     → the speaker;
 *   - second-person ("you", "your") or the addressee's own name
 *     → the addressee;
 *   - anything else → none (normal name/embedding resolution).
 * One rule for both ingest paths (the direct persister and the document
 * commit writer).
 */
export function coreferentParticipant(
  name: string,
  { speaker, addressee }: Participants,
): KnownEntity | undefined {
  if (speaker && (isFirstPersonSelfReference(name) || matchesParticipantName(name, speaker.name))) {
    return speaker;
  }
  if (
    addressee &&
    (isSecondPersonReference(name) || matchesParticipantName(name, addressee.name))
  ) {
    return addressee;
  }
  return undefined;
}

export function participantHint(
  k: KnownEntity | undefined,
  userId: string | undefined,
): ParticipantHint | undefined {
  if (!k) return undefined;
  return {
    vertical: k.vertical,
    id: k.id,
    role: k.role,
    name: k.name,
    ...(isUserEntityRef(k, userId) ? { userId } : {}),
  };
}

/**
 * The mention with the user as its speaker when the caller declared none
 * (and no userId → the mention as it came). `name` is the user's display
 * name as far as it is known — the caller's, the entity's, the token's —
 * else the userId itself stands in, exactly as a reference-minted entity
 * is named by its reference id until someone names it. A caller that
 * anchored the speaker on the user's own reference without a name gets
 * the name filled in the same way.
 */
export function withUserAsSpeaker(
  dto: IngestMentionDto,
  name: string | undefined,
): IngestMentionDto {
  const { userId } = dto;
  if (!userId) return dto;
  const display = name ?? userId;
  const { speaker } = participantsOf(dto);
  if (speaker) {
    if (!isUserEntityRef(speaker, userId) || speaker.name) return dto;
    return {
      ...dto,
      knownEntities: dto.knownEntities!.map((k) => (k === speaker ? { ...k, name: display } : k)),
    };
  }
  const self: KnownEntity = { ...userEntityRef(userId), role: 'speaker', name: display };
  return { ...dto, knownEntities: [self, ...(dto.knownEntities ?? [])] };
}
