import { Injectable, Logger } from '@nestjs/common';
import {
  evidenceDerivedMaxBytes,
  evidenceMaxBytes,
  evidenceRemoteParserAllowPrivate,
  evidenceRemoteParserEnabled,
  evidenceRemoteParserMediaTypes,
  evidenceRemoteParserProfile,
  evidenceRemoteParserToken,
  evidenceRemoteParserUrl,
} from '../../../common/evidence-flags';
import type { EvidenceModality } from '../../../common/evidence-taxonomy';
import { safeFetch } from '../../../source-plane/connectors/safe-fetch';
import type { ProcessorAdapter, ProcessorInput, ProcessorOutput } from '../processor-adapter';
import { openAssetBytes, withDeadline } from './adapter-io';

/**
 * RemoteParserAdapter — the quality tier of document text (W6), and the
 * FIRST platform processor that is allowed to make a network call.
 *
 * Every other text adapter is local by construction and says so in
 * capitals: pdf2json for a PDF's text layer, officeparser for OOXML,
 * tesseract for pixels — deterministic, free, offline. They are also the
 * FLOOR. A PDF whose layout carries meaning (a table, a two-column
 * paper, a form) comes out of a text-layer dump as prose soup, and no
 * amount of local tuning fixes that: reconstructing document STRUCTURE
 * is a model's job. Docling, marker, unstructured and the hosted
 * equivalents all do it, all cost something, and all see the bytes.
 *
 * So this adapter is the operator's explicit decision, four times over:
 * the flag, the URL, the media types it may take, and the private-host
 * opt-in when the service runs inside their own network. With any of
 * them unset it accepts NOTHING and the registry is byte-identical to
 * the local-only one — it sits first, and first-match dispatch over an
 * adapter that accepts nothing is the same list without it.
 *
 * THE CONTRACT IS OURS, not a vendor's. One endpoint, JSON in, JSON out:
 *
 *   POST <url>                  { mediaType, filename?, profile?, contentBase64 }
 *   200  { text }  |  { markdown }  |  { content }
 *
 * Every real parser needs a shim in front of it (docling speaks
 * multipart, not this), and that is deliberate: a ten-line shim the
 * operator owns is a smaller surface than a matrix of vendor protocols
 * in platform code, and it is the seam where an operator adds their own
 * redaction before bytes leave.
 *
 * The egress guard runs on the call like any other network hop, the
 * bearer never appears in an error, and the answer is bounded by the
 * same derived-bytes cap every representation is. A failure is a run
 * failure — it is never a quiet fallthrough to the local adapter,
 * because "the good parser was down so the tables became soup" is
 * exactly the kind of silence this plane refuses.
 */
@Injectable()
export class RemoteParserAdapter implements ProcessorAdapter {
  private readonly logger = new Logger(RemoteParserAdapter.name);
  readonly capability = 'text' as const;
  readonly version = 'remote-parser-v1';

  /**
   * The service and its mode ride the fingerprint: pointing at a
   * different parser, or flipping its profile, produces different text
   * under an unchanged (capability, version), and a stale
   * representation served from the old key would be a lie about what
   * the document says. The bearer never rides it — it is a credential,
   * not a knob.
   */
  configParts(): string[] {
    return [`url=${evidenceRemoteParserUrl()}`, `profile=${evidenceRemoteParserProfile()}`];
  }

  accepts(modality: EvidenceModality, mediaType: string): boolean {
    if (!evidenceRemoteParserEnabled() || evidenceRemoteParserUrl().length === 0) return false;
    if (modality !== 'document') return false;
    return evidenceRemoteParserMediaTypes().includes(mediaType.toLowerCase());
  }

  async process(input: ProcessorInput): Promise<ProcessorOutput[]> {
    const url = evidenceRemoteParserUrl();
    if (!evidenceRemoteParserEnabled() || url.length === 0) {
      throw new Error('remote parser: not configured');
    }
    const bytes = await openAssetBytes(input, evidenceMaxBytes());
    const token = evidenceRemoteParserToken();
    const profile = evidenceRemoteParserProfile();
    const body = JSON.stringify({
      mediaType: input.asset.mediaType,
      ...(profile.length > 0 ? { profile } : {}),
      contentBase64: bytes.toString('base64'),
    });
    const res = await withDeadline(
      safeFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
        },
        body,
        maxBytes: evidenceDerivedMaxBytes(),
        allowPrivate: evidenceRemoteParserAllowPrivate(),
        timeoutMs: DEADLINE_MS,
      }),
      { ms: DEADLINE_MS, label: 'remote parser' },
    );
    if (res.status >= 400) {
      // The bytes we sent and the bearer we sent them with never appear
      // in the message; the status and the service's own words do.
      throw new Error(
        `remote parser answered ${String(res.status)}: ${snippet(res.body.toString('utf8'))}`,
      );
    }
    const text = textOf(res.body.toString('utf8'));
    if (text === null) throw new Error('remote parser: the answer carried no text');
    if (text.trim().length === 0) {
      throw new Error('remote parser: the answer was empty — the document was not read');
    }
    this.logger.log(
      `remote parser read ${String(bytes.byteLength)} bytes of ${input.asset.mediaType} ` +
        `into ${String(text.length)} characters`,
    );
    return [{ kind: 'text', content: text }];
  }
}

const DEADLINE_MS = 120_000;

/** The three keys a parser might call its answer, in the order we prefer them. */
export function textOf(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as Record<string, unknown>;
  for (const key of ['markdown', 'text', 'content']) {
    const v = body[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

function snippet(s: string): string {
  return s.slice(0, 200).replace(/\s+/g, ' ');
}
