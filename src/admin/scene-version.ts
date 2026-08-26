import { Injectable } from '@nestjs/common';
import { FactEmbeddingService } from '../ingest/fact-embedding.service';
import {
  sceneMaxTurns,
  sceneTopicBoundaryEnabled,
  sceneTopicMinCosine,
  sceneVersionFingerprintEnabled,
} from '../common/scene-flags';
import {
  SEGMENTER_VERSION,
  effectiveSegmenterVersion,
  type SceneSegmenterConfig,
} from './scene-segmentation';

/** One run's resolved scene world: the version string + the config behind it. */
export interface SceneVersionResolution {
  /**
   * The effective segmenter version — every stamp, record id, registry key
   * and WHERE of the run uses THIS string. The literal SEGMENTER_VERSION
   * constant unless SCENES_VERSION_FINGERPRINT is on.
   */
  version: string;
  /** The resolved segmenter config the run must segment with. */
  cfg: SceneSegmenterConfig;
}

/**
 * Per-RUN resolution of the effective scene world (Drift-3).
 *
 * The composer/enricher/backlinker call `resolve()` ONCE at the start of a
 * run and pass the result down — flags/knobs are read at call time (so a
 * flip is runtime-mutable, no restart), but never re-read inside a run's
 * loop, so a mid-run env flip can never mix id-spaces or stamp a version
 * that disagrees with the content it was segmented under.
 *
 * With SCENES_VERSION_FINGERPRINT off (default) the version is exactly the
 * literal PR2 `SEGMENTER_VERSION` constant — byte-identical stamps, record
 * ids and projection-registry keys. When on, the version carries an
 * 8-hex-char fingerprint of the resolved config
 * (`scene-segmenter-v1+<fp>`), so a config change forks a NEW coexisting
 * id-space (migration 0106's coexistence promise) instead of silently
 * overwriting the same record ids with different content.
 *
 * Why a fingerprint and not a caller-supplied version (the window-deriver
 * precedent): scenes have no read pin / read lane yet and the knobs are
 * env-resolved, not per-request — deriving the version from the resolved
 * config is the smallest mechanism that makes "different algorithm ⇒
 * different world" structurally true.
 */
@Injectable()
export class SceneVersionService {
  constructor(private readonly embedding: FactEmbeddingService) {}

  resolve(): SceneVersionResolution {
    const topicBoundary = sceneTopicBoundaryEnabled();
    const cfg: SceneSegmenterConfig = {
      topicBoundary,
      minCosine: sceneTopicMinCosine(),
      maxTurns: sceneMaxTurns(),
      // The space is part of scene identity only when embeddings are
      // actually taken; with the boundary off it cannot affect output.
      embeddingSpaceId: topicBoundary ? this.embedding.activeSpaceId() : null,
    };
    const version = sceneVersionFingerprintEnabled()
      ? effectiveSegmenterVersion(cfg)
      : SEGMENTER_VERSION;
    return { version, cfg };
  }
}
