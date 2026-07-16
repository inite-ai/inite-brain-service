import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SurrealService } from '../db/surreal.service';
import { retryOnUniqueViolation } from '../db/surreal-retry';
import { isHttpUrl } from './marketplace-meta';
import type { PublisherProfile } from '../contracts/registry/marketplace.schema';

interface ProfileRow {
  id: unknown;
  publisher: string;
  displayName: string;
  url?: string | null;
  bio?: string;
  contactEmail?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

// Loose email shape — enough to catch a pasted URL or a bare word, not an
// RFC 5321 validator (the address is display metadata, nothing is sent).
const LOOSE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Public marketplace profiles per registry publisher id (migration 0067;
 * docs/domain-packs.md "Marketplace"). The write rule is the whole point:
 * only a company that has published at least one VERIFIED pack under a
 * publisher may write that publisher's profile — the ed25519 signature
 * validated against this instance's trust store is what ties a companyId
 * to the publisher name. Without it, anyone could squat a well-known
 * publisher's public page. Reads are open to any brain:read caller (and
 * the public /registry/ui page).
 */
@Injectable()
export class PublisherProfileService {
  private readonly logger = new Logger(PublisherProfileService.name);

  constructor(private readonly surreal: SurrealService) {}

  async get(publisher: string): Promise<PublisherProfile | null> {
    const row = await this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[ProfileRow[]]>(
        `SELECT * FROM publisher_profile WHERE publisher = $publisher LIMIT 1`,
        { publisher },
      );
      return ((rows as ProfileRow[]) ?? [])[0] ?? null;
    });
    return row ? this.toProfile(row) : null;
  }

  /** Full-replace upsert: absent optional fields clear to NONE, so a
   *  publisher can retract a stale URL/email by omitting it. */
  async upsert(args: {
    publisher: string;
    companyId: string;
    profile: {
      displayName: string;
      url?: string;
      bio?: string;
      contactEmail?: string;
    };
  }): Promise<PublisherProfile> {
    const clean = this.validate(args.profile);
    await this.assertVerifiedPublisher(args);
    await this.surreal.withAdminDb((db) =>
      retryOnUniqueViolation(async () => {
        const [rows] = await db.query<[Array<{ id: unknown }>]>(
          `SELECT id FROM publisher_profile WHERE publisher = $publisher LIMIT 1`,
          { publisher: args.publisher },
        );
        let id = ((rows as Array<{ id: unknown }>) ?? [])[0]?.id;
        if (!id) {
          const [created] = await db.query<[Array<{ id: unknown }>]>(
            `CREATE publisher_profile CONTENT
               { publisher: $publisher, displayName: $displayName, createdBy: $createdBy }`,
            {
              publisher: args.publisher,
              displayName: clean.displayName,
              createdBy: args.companyId,
            },
          );
          id = ((created as Array<{ id: unknown }>) ?? [])[0]?.id;
        }
        await db.query(
          `UPDATE $row SET displayName = $displayName, bio = $bio,
             url = ${clean.url ? '$url' : 'NONE'},
             contactEmail = ${clean.contactEmail ? '$email' : 'NONE'},
             updatedAt = time::now()`,
          {
            row: id,
            displayName: clean.displayName,
            bio: clean.bio,
            ...(clean.url ? { url: clean.url } : {}),
            ...(clean.contactEmail ? { email: clean.contactEmail } : {}),
          },
        );
      }),
    );
    this.logger.log(
      `Publisher profile "${args.publisher}" upserted by ${args.companyId}`,
    );
    const profile = await this.get(args.publisher);
    // The row was just written; a miss here is a datastore fault.
    if (!profile) {
      throw new Error(`publisher_profile "${args.publisher}" vanished mid-upsert`);
    }
    return profile;
  }

  // ── internals ─────────────────────────────────────────────────────────

  /** The verified-ownership rule (see class doc): ≥1 registry_pack row
   *  with this publisher, published by this company, verified=true. */
  private async assertVerifiedPublisher(args: {
    publisher: string;
    companyId: string;
  }): Promise<void> {
    const owned = await this.surreal.withAdminDb(async (db) => {
      const [rows] = await db.query<[Array<{ id: unknown }>]>(
        `SELECT id FROM registry_pack
           WHERE publisher = $publisher AND publishedBy = $companyId
             AND verified = true LIMIT 1`,
        { publisher: args.publisher, companyId: args.companyId },
      );
      return ((rows as Array<{ id: unknown }>) ?? []).length > 0;
    });
    if (!owned) {
      throw new ForbiddenException(
        `profile for publisher "${args.publisher}" requires at least one VERIFIED pack published under it by this company`,
      );
    }
  }

  private validate(profile: {
    displayName: string;
    url?: string;
    bio?: string;
    contactEmail?: string;
  }): { displayName: string; url?: string; bio: string; contactEmail?: string } {
    const displayName = String(profile.displayName ?? '').trim();
    if (!displayName || displayName.length > 120) {
      throw new BadRequestException(
        'displayName must be a non-empty string of at most 120 characters',
      );
    }
    const bio = String(profile.bio ?? '');
    if (bio.length > 2000) {
      throw new BadRequestException('bio must be at most 2000 characters');
    }
    const url = profile.url?.trim();
    if (url && !isHttpUrl(url)) {
      throw new BadRequestException('url must be a valid http(s) URL');
    }
    const contactEmail = profile.contactEmail?.trim();
    if (contactEmail && !LOOSE_EMAIL.test(contactEmail)) {
      throw new BadRequestException('contactEmail must look like an email address');
    }
    return {
      displayName,
      bio,
      ...(url ? { url } : {}),
      ...(contactEmail ? { contactEmail } : {}),
    };
  }

  private toProfile(row: ProfileRow): PublisherProfile {
    return {
      publisher: row.publisher,
      displayName: row.displayName,
      url: row.url ?? null,
      bio: row.bio ?? '',
      contactEmail: row.contactEmail ?? null,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: row.updatedAt
        ? new Date(row.updatedAt as string).toISOString()
        : null,
    };
  }
}
