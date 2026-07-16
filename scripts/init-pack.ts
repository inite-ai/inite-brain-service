#!/usr/bin/env ts-node
/**
 * Domain Pack scaffold CLI (docs/domain-packs.md § Quickstart).
 *
 *   pnpm pack:init <pack_id>
 *
 * Writes `./<pack_id>.pack.json` — a valid, installable skeleton manifest a
 * community author edits into a real pack: one example predicate (the
 * TYPE/ADMIT/VALUE card format the extractor consumes), an extractionProfile
 * stub, one evalFixture, and a clearly-marked OPTIONAL `indexer` example
 * showing the three document-pipeline modes (virtual / dedicated / external).
 *
 * The id must be snake_case, must not contain the reserved `__` separator or
 * end with `_`, and must not shadow a builtin/first-party pack id. The fresh
 * skeleton already passes `pnpm pack:validate` — edit, re-validate, then
 * sign/publish/install (see the quickstart in docs/domain-packs.md).
 *
 * `makePackSkeleton` is exported pure so the unit suite
 * (test/pack-init.unit-spec.ts) can assert the skeleton stays valid.
 */
import { writeFileSync } from 'node:fs';
import {
  BUILTIN_PACKS,
  FIRST_PARTY_PACKS,
} from '../src/ai/domain-packs';
import { DomainPackError, validatePack } from '../src/ai/domain-packs/validate';
import type { DomainPackManifest } from '../src/ai/domain-packs/manifest';

/** Ids already taken by builtin (globally seeded) or first-party
 *  (distributable, shipped in packs/) manifests — a community pack must not
 *  shadow them. */
export const RESERVED_PACK_IDS: ReadonlySet<string> = new Set(
  [...BUILTIN_PACKS, ...FIRST_PARTY_PACKS].map((p) => p.id),
);

/** The skeleton is a valid DomainPackManifest plus one advisory, non-standard
 *  `// indexer` key (unknown keys are ignored by validatePack/assembleSeed)
 *  that documents the OPTIONAL indexer descriptor. Authors delete it or
 *  promote one of its shapes to a real top-level `indexer` field. */
export type PackSkeleton = DomainPackManifest & {
  '// indexer': Record<string, unknown>;
};

/**
 * Build the starter manifest for a new community pack. Pure — no filesystem.
 * Throws DomainPackError on an invalid id (charset / `__` / trailing `_`,
 * enforced by validatePack) or a reserved builtin/first-party id.
 */
export function makePackSkeleton(id: string): PackSkeleton {
  if (RESERVED_PACK_IDS.has(id)) {
    throw new DomainPackError(
      `pack id "${id}" is reserved by a builtin/first-party pack — pick another id`,
    );
  }
  const skeleton: PackSkeleton = {
    id,
    version: '0.1.0',
    description: `TODO: one-line human description of the ${id} pack.`,
    predicates: [
      {
        localId: 'example_predicate',
        displayLabel: 'example predicate',
        description:
          'TYPE   subject is a <what kind of entity>; value is <what the value means>\n' +
          'ADMIT  text states <when the extractor should emit this fact>\n' +
          'VALUE  the value, verbatim from the text',
        datatype: 'string',
        semantics: 'single_active',
        decayHalfLifeDays: null,
        piiClass: 'none',
        status: 'active',
      },
    ],
    extractionProfile: {
      guidance: `TODO: domain framing appended to the extractor system prompt. Name the subject entity type and steer toward the ${id}__* predicates. Advisory — never overrides the VERBATIM RULE or the strict output schema.`,
      fewShot: [
        {
          text: 'TODO: a short sample input snippet from your domain.',
          note: `TODO: what a correct extraction captures, e.g. subject → ${id}__example_predicate='<value>'.`,
        },
      ],
    },
    evalFixtures: [
      {
        id: 'example',
        description:
          'TODO: what this fixture proves. Run via POST /v1/admin/packs/:packId/eval.',
        text: 'TODO: input text the LIVE extractor is run against.',
        expect: {
          facts: [
            {
              // Bare localId resolves to the pack namespace (<id>__example_predicate).
              predicate: 'example_predicate',
              objectIncludes: 'TODO substring the extracted value must contain',
            },
          ],
        },
      },
    ],
    '// indexer': {
      '//':
        'OPTIONAL document-pipeline descriptor (docs/domain-packs.md § Indexer descriptor). ' +
        "Absent = 'virtual': the pack rides the single union extraction call at zero extra " +
        'LLM cost. To opt in, add a top-level "indexer" field shaped like ONE of the ' +
        'examples below, then delete this whole "// indexer" block.',
      virtual: { mode: 'virtual' },
      dedicated: {
        mode: 'dedicated',
        relevance: {
          keywords: ['example', 'keywords'],
          description: 'Documents this pack should index (embedded for the cosine gate)',
          threshold: 0.3,
        },
        dedicated: { includeCorePredicates: true, scPasses: 1 },
      },
      external: {
        mode: 'external',
        relevance: { keywords: ['example'] },
        external: { publisher: 'your_publisher_id' },
      },
    },
  };
  // Same gate as `pnpm pack:validate` — enforces the id rules (snake_case,
  // no "__", no trailing "_") and keeps the skeleton honest as the standard
  // evolves. A skeleton that doesn't validate is a bug in this script.
  validatePack(skeleton);
  return skeleton;
}

function main(): void {
  const id = process.argv[2];
  if (!id) {
    throw new Error('usage: pack:init <pack_id>   (snake_case, e.g. my_pack)');
  }
  const skeleton = makePackSkeleton(id);
  const out = `${id}.pack.json`;
  // Exclusive create ('wx') fails atomically if the file already exists —
  // no check-then-write TOCTOU window.
  try {
    writeFileSync(out, `${JSON.stringify(skeleton, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing ${out}`);
    }
    throw e;
  }
  console.log(`✓ wrote ${out} — a valid starter manifest for pack "${id}"`);
  console.log('next steps (docs/domain-packs.md § Quickstart):');
  console.log(`  1. edit ${out} — predicates, extractionProfile, evalFixtures`);
  console.log(`  2. pnpm pack:validate ${out}`);
  console.log(
    `  3. pnpm pack:sign -- --file ${out} --key priv.pem --publisher <you>`,
  );
  console.log(
    `  4. BRAIN_API_KEY=... pnpm pack:publish -- --brain-url <url> --file ${out} --verify`,
  );
  console.log(
    `  5. BRAIN_API_KEY=... pnpm pack:install -- --brain-url <url> --registry ${id}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`✗ pack:init failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
