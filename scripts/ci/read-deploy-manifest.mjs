#!/usr/bin/env node
// Reads the deploy manifest CI published for this commit and emits the
// image reference the deploy must pin.
//
// The manifest is written by ci.yml's `docker` job on main, after that
// job has pushed the image AND pulled the published digest back and
// smoke-tested it. It carries a digest, not a tag: a tag is a mutable
// pointer that resolves to whatever the registry says at pull time, and
// "deploy the image CI tested" is not a claim a tag can support.
//
// Three ways this refuses to produce an image, all of them loud:
//   - the manifest is missing        => CI did not publish for this commit
//   - its sha is not our sha         => the artifact belongs to another commit
//   - its image is not digest-pinned => somebody replaced the digest with a tag
// Each exits 1. A deploy with no verified artifact does not proceed.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const PATH = process.env.MANIFEST_PATH ?? 'deploy-manifest.json';
const EXPECTED_SHA = process.env.EXPECTED_SHA;

function fail(message) {
  console.error(`[manifest] ${message}`);
  process.exit(1);
}

if (!existsSync(PATH)) {
  fail(
    `${PATH} not found. CI publishes it from the docker job on main; its absence ` +
      'means no verified image exists for this commit. Re-run CI on this commit ' +
      'before deploying.',
  );
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(PATH, 'utf8'));
} catch (err) {
  fail(`${PATH} is not valid JSON: ${err.message}`);
}

if (!EXPECTED_SHA) fail('EXPECTED_SHA is not set — cannot confirm the manifest is ours');

if (manifest.sha !== EXPECTED_SHA) {
  fail(
    `manifest is for commit ${manifest.sha}, but this deploy is for ${EXPECTED_SHA}. ` +
      'Deploying it would ship a different commit than the one that triggered this run.',
  );
}

const image = String(manifest.image ?? '');
if (!image.includes('@sha256:')) {
  fail(`manifest image "${image}" is not digest-pinned. Refusing to deploy a mutable tag.`);
}

console.log(`[manifest] commit ${manifest.sha} -> ${image}`);

const out = process.env.GITHUB_OUTPUT;
if (!out) fail('GITHUB_OUTPUT is not set');
appendFileSync(out, `image=${image}\ndigest=${manifest.digest}\n`);
