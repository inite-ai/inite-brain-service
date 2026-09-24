import { Injectable, Logger } from '@nestjs/common';
import type { Surreal } from 'surrealdb';
import { queryFirst, SurrealService } from '../db/surreal.service';
import { traceArtifact } from '../common/debug-trace';
import type { IngestMentionDto } from './dto/ingest-mention.dto';
import { EntityUpsertService } from './entity-upsert.service';
import { participantsOf, withUserAsSpeaker } from './participants';
import { isUserEntityRef, userEntityKey } from './user-entity';

/** The user's own entity as the memory currently holds it. */
export interface UserEntity {
  id: string;
  /** The current canonical name — the userId itself until someone named it. */
  name: string;
  /** Whether `name` is a name rather than the userId placeholder. */
  named: boolean;
}

/**
 * The one reader of "who is this user in the memory" (user-entity.ts):
 * the ingest paths ask it to put the user among a turn's participants,
 * the extractor's memory context pins the user's entity as known, and
 * the answer plane asks it who the asker is. The entity itself is minted
 * by the ingest path's own resolution when the user first speaks; the
 * one write here is the user's NAME, when a caller gives it.
 */
@Injectable()
export class UserEntityService {
  private readonly logger = new Logger(UserEntityService.name);

  constructor(
    private readonly surreal: SurrealService,
    private readonly entities: EntityUpsertService,
  ) {}

  /** The user's own entity, or null when no turn of theirs has minted it yet. */
  async lookup(db: Surreal, userId: string): Promise<UserEntity | null> {
    const row = await queryFirst<{ id: unknown; canonicalName: string; mergedInto: unknown }>(
      db,
      `SELECT entity.id AS id, entity.canonicalName AS canonicalName, entity.mergedInto AS mergedInto
         FROM entity_external_ref WHERE key = $key LIMIT 1`,
      { key: userEntityKey(userId) },
    );
    if (!row?.id) return null;
    // A merged identity is read through to its survivor, like `known`.
    const id = String(row.mergedInto ?? row.id);
    const name = String(row.canonicalName ?? userId);
    return { id, name, named: name !== userId };
  }

  /** `lookup` in its own session; null on any failure — identity is an enrichment. */
  async resolve(companyId: string, userId: string): Promise<UserEntity | null> {
    try {
      return await this.surreal.withCompany(companyId, (db) => this.lookup(db, userId));
    } catch (e) {
      this.logger.warn(`user entity unavailable (companyId=${companyId}): ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * The mention with the user among its participants (participants.ts).
   * The user's display name comes from the caller's own anchor when it
   * names the user, else from the entity the memory already holds — the
   * name it learned from the user's own words or an onboarding fact
   * (entity-name.ts); with none, the userId stands in until one arrives.
   * Never from the token: a credential says WHO (the subject), the
   * memory learns what they are called. A name the caller gives reaches
   * the entity here — whatever rung the turn's extraction resolves
   * through — so the next turn, the episode and the asker all carry it.
   */
  async participants(companyId: string, dto: IngestMentionDto): Promise<IngestMentionDto> {
    const out = await this.resolveParticipants(companyId, dto);
    const { speaker, addressee } = participantsOf(out);
    traceArtifact('ingest.participants', {
      speaker: speaker ? `${speaker.vertical}:${speaker.id}` : null,
      speakerName: speaker?.name ?? null,
      speakerIsUser: isUserEntityRef(speaker, out.userId),
      addressee: addressee ? `${addressee.vertical}:${addressee.id}` : null,
    });
    return out;
  }

  private async resolveParticipants(
    companyId: string,
    dto: IngestMentionDto,
  ): Promise<IngestMentionDto> {
    const { userId } = dto;
    if (!userId) return dto;
    const { speaker } = participantsOf(dto);
    if (speaker && !isUserEntityRef(speaker, userId)) return dto;
    const given = speaker?.name?.trim() || undefined;
    const known = await this.readAndName(companyId, userId, given);
    return withUserAsSpeaker(dto, given ?? (known?.named ? known.name : undefined));
  }

  /** One session: the user's entity, named with `given` when it has one and that is news to it. */
  private async readAndName(
    companyId: string,
    userId: string,
    given: string | undefined,
  ): Promise<UserEntity | null> {
    try {
      return await this.surreal.withCompany(companyId, async (db) => {
        const known = await this.lookup(db, userId);
        if (known && given && given !== known.name) {
          await this.entities.nameParticipant(db, known.id, { id: userId, name: given });
        }
        return known;
      });
    } catch (e) {
      this.logger.warn(`user entity unavailable (companyId=${companyId}): ${(e as Error).message}`);
      return null;
    }
  }
}
