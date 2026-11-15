import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import {
  FirstPartyPackSeedService,
  FIRST_PARTY_PACK_DIR,
  readFirstPartyPacks,
} from '../src/registry/first-party-pack-seed.service';
import type { PackRegistryService } from '../src/registry/pack-registry.service';
import type { DomainPackManifest } from '../src/ai/domain-packs';

/**
 * The registry is filled by the release, not by a hand-run script:
 * production's static keys are off, so `pnpm registry:seed` had no
 * credential there and `POST /v1/admin/packs/from-registry` 404'd for
 * every first-party pack. The image now carries packs/ and each boot
 * publishes it through the normal, idempotent publish path.
 */
describe('first-party pack seed', () => {
  const savedFlag = process.env.REGISTRY_SEED_FIRST_PARTY;
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.REGISTRY_SEED_FIRST_PARTY;
    else process.env.REGISTRY_SEED_FIRST_PARTY = savedFlag;
  });

  /** An in-memory registry with publish's idempotence and immutability. */
  function fakeRegistry() {
    const rows = new Map<string, string>();
    const publish = jest.fn(async ({ manifest }: { manifest: DomainPackManifest }) => {
      const key = `${manifest.id}@${manifest.version}`;
      const body = JSON.stringify(manifest);
      const prior = rows.get(key);
      if (prior !== undefined && prior !== body) {
        throw new ConflictException(
          `pack "${manifest.id}" version ${manifest.version} is immutable`,
        );
      }
      rows.set(key, body);
      return {
        packId: manifest.id,
        version: manifest.version,
        checksum: 'x',
        created: prior === undefined,
      };
    });
    return { rows, publish, registry: { publish } as unknown as PackRegistryService };
  }

  it('reads every manifest the repo ships, from the path the image copies them to', () => {
    const packs = readFirstPartyPacks();
    expect(FIRST_PARTY_PACK_DIR).toBe(join(__dirname, '..', 'packs'));
    expect(packs.length).toBeGreaterThanOrEqual(12);
    expect(packs.map((p) => p.id)).toContain('relationship');
  });

  it('publishes them all on the first boot and nothing on the second', async () => {
    const { registry, rows } = fakeRegistry();
    const svc = new FirstPartyPackSeedService(registry);
    const packs = readFirstPartyPacks();
    expect(await svc.seed(packs)).toEqual({ published: packs.length, present: 0, failed: 0 });
    expect(rows.size).toBe(packs.length);
    expect(await svc.seed(packs)).toEqual({ published: 0, present: packs.length, failed: 0 });
  });

  it('a refused pack is logged and counted, and the rest still publish', async () => {
    const { registry } = fakeRegistry();
    const svc = new FirstPartyPackSeedService(registry);
    const [a, b] = readFirstPartyPacks();
    await svc.seed([a!]);
    const edited = { ...a!, description: 'edited without a version bump' };
    expect(await svc.seed([edited, b!])).toEqual({ published: 1, present: 0, failed: 1 });
  });

  it('runs off the boot path and stays off when disabled', async () => {
    const { registry, publish } = fakeRegistry();
    process.env.REGISTRY_SEED_FIRST_PARTY = '0';
    new FirstPartyPackSeedService(registry).onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(publish).not.toHaveBeenCalled();

    delete process.env.REGISTRY_SEED_FIRST_PARTY;
    const svc = new FirstPartyPackSeedService(registry);
    const seeded = jest.spyOn(svc, 'seed');
    expect(svc.onApplicationBootstrap()).toBeUndefined();
    expect(seeded).toHaveBeenCalledTimes(1);
  });

  it('the runtime image copies packs/ next to dist/', () => {
    const dockerfile = readFileSync(join(__dirname, '..', 'Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(runtime).toMatch(/^COPY packs \.\/packs$/m);
    expect(runtime).toMatch(/^WORKDIR \/app$/m);
  });
});
