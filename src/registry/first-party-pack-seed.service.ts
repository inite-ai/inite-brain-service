import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envFlagNotDisabled } from '../common/env-validation';
import type { DomainPackManifest } from '../ai/domain-packs';
import { PackRegistryService } from './pack-registry.service';

/**
 * Where the first-party pack manifests live: `packs/` at the app root.
 * `dist/registry/…` and `src/registry/…` both sit two levels below it, so
 * one relative path serves the image (`COPY packs ./packs`, Dockerfile)
 * and a source checkout alike.
 */
export const FIRST_PARTY_PACK_DIR = join(__dirname, '..', '..', 'packs');

export interface PackSeedSummary {
  published: number;
  present: number;
  failed: number;
}

/** The manifests shipped in `dir` (`*.pack.json`), in a stable order. */
export function readFirstPartyPacks(dir: string = FIRST_PARTY_PACK_DIR): DomainPackManifest[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.pack.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as DomainPackManifest);
}

/**
 * Publishes the first-party packs (`packs/*.pack.json`) into the GLOBAL
 * registry on every boot, so `POST /v1/admin/packs/from-registry` finds
 * them on any deployment without a hand-run `pnpm registry:seed`.
 *
 * Why at boot and not in the deploy workflow: publishing needs
 * `registry:publish`, which only a static env key carries, and production
 * disables static keys under a remote verifier — the manual script had no
 * credential it could use there, which is how prod's registry stayed
 * empty. In-process, the seed goes through `PackRegistryService.publish`
 * directly: the same validation, builtin-id fence, signed-packs policy and
 * version immutability an operator publish gets.
 *
 * Off every request path: fired from onApplicationBootstrap and not
 * awaited, so boot and /ready never wait on it, and a failure is logged,
 * never thrown. Idempotent: an identical (packId, version) answers
 * `created: false`; replicas racing on the same version are settled by the
 * UNIQUE index (publish's retryOnUniqueViolation). A repo pack whose
 * version is already published with OTHER content (an edit without a
 * version bump) is a 409 from the registry — logged, and the shipped row
 * stays as it was: versions are immutable.
 *
 * `REGISTRY_SEED_FIRST_PARTY=0` turns it off (the e2e fixture does, so a
 * registry spec sees only the packs it publishes).
 */
@Injectable()
export class FirstPartyPackSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FirstPartyPackSeedService.name);

  constructor(private readonly registry: PackRegistryService) {}

  onApplicationBootstrap(): void {
    if (!envFlagNotDisabled(process.env.REGISTRY_SEED_FIRST_PARTY)) return;
    void this.seed().catch((err: unknown) =>
      this.logger.warn(`first-party pack seed failed: ${(err as Error).message}`),
    );
  }

  async seed(manifests: DomainPackManifest[] = readFirstPartyPacks()): Promise<PackSeedSummary> {
    const summary: PackSeedSummary = { published: 0, present: 0, failed: 0 };
    for (const manifest of manifests) {
      try {
        const res = await this.registry.publish({ manifest, publishedBy: 'first-party' });
        if (res.created) summary.published += 1;
        else summary.present += 1;
      } catch (err) {
        summary.failed += 1;
        this.logger.warn(
          `first-party pack ${manifest.id} v${manifest.version} not published: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `first-party packs: ${summary.published} published, ${summary.present} already present, ${summary.failed} failed`,
    );
    return summary;
  }
}
