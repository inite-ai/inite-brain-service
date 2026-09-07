/**
 * Real PDF text extraction (Brain v2.1 MM) — asserts against REAL parsed
 * bytes. Every fixture is a valid PDF assembled byte-by-byte in-process
 * (a few hundred bytes each, with a correct xref table), so nothing
 * binary is committed and the spec still proves the adapter reads what a
 * PDF actually contains rather than what a mock was told to return.
 */
import { Readable } from 'node:stream';
import { DocumentTextAdapter } from '../src/evidence/processing/adapters/document-text.adapter';
import type {
  ProcessorAdapter,
  ProcessorInput,
} from '../src/evidence/processing/processor-adapter';
import { processorConfigFingerprint } from '../src/evidence/processing/processor-fingerprint';

const adapter = new DocumentTextAdapter();

/**
 * Assemble a minimal but STRUCTURALLY VALID PDF: one content stream per
 * page, a real cross-reference table with computed byte offsets, and a
 * trailer. Escaping is deliberate — a `(` in page text would otherwise
 * end the string operand early.
 */
function buildPdf(pageStreams: string[]): Buffer {
  const pageCount = pageStreams.length;
  const fontNum = 3 + pageCount * 2;
  const objects: Record<number, string> = {};
  const kids = pageStreams.map((_stream, i) => `${String(3 + i * 2)} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${String(pageCount)} >>`;
  pageStreams.forEach((stream, i) => {
    const pageNum = 3 + i * 2;
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${String(pageNum + 1)} 0 R ` +
      `/Resources << /Font << /F1 ${String(fontNum)} 0 R >> >> >>`;
    objects[pageNum + 1] =
      `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\n` +
      `stream\n${stream}endstream`;
  });
  objects[fontNum] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  let body = '%PDF-1.4\n';
  const offsets: Record<number, number> = {};
  for (let n = 1; n <= fontNum; n++) {
    offsets[n] = Buffer.byteLength(body, 'latin1');
    body += `${String(n)} 0 obj\n${objects[n]!}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(body, 'latin1');
  let xref = `xref\n0 ${String(fontNum + 1)}\n0000000000 65535 f \n`;
  for (let n = 1; n <= fontNum; n++) {
    xref += `${String(offsets[n]!).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${String(fontNum + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xrefAt)}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

/** One `Tj` per line, laid out top-down from y=700 at 20pt leading. */
function textPage(lines: string[]): string {
  return lines
    .map((line, i) => {
      const escaped = line.replace(/([()\\])/g, '\\$1');
      return `BT /F1 12 Tf 72 ${String(700 - i * 20)} Td (${escaped}) Tj ET\n`;
    })
    .join('');
}

function inputFor(bytes: Buffer | null, over: Partial<ProcessorInput['asset']> = {}) {
  const asset: ProcessorInput['asset'] = {
    id: 'evidence_asset:d1',
    modality: 'document',
    mediaType: 'application/pdf',
    availability: bytes === null ? 'external' : 'hot',
    byteLength: bytes?.byteLength ?? 100,
    ...over,
  };
  return {
    asset,
    openStream: bytes === null ? null : () => Promise.resolve(Readable.from([bytes])),
  };
}

describe('DocumentTextAdapter.accepts', () => {
  it('takes PDFs on the document modality', () => {
    expect(adapter.accepts('document', 'application/pdf')).toBe(true);
    expect(adapter.accepts('document', 'APPLICATION/PDF')).toBe(true);
    expect(adapter.accepts('document', 'application/pdf; version=1.7')).toBe(true);
    expect(adapter.accepts('document', 'application/x-pdf')).toBe(true);
  });

  it('leaves plain-text documents to the passthrough adapter', () => {
    expect(adapter.accepts('document', 'text/plain')).toBe(false);
    expect(adapter.accepts('document', 'application/json')).toBe(false);
    expect(adapter.accepts('document', 'text/markdown')).toBe(false);
  });

  it('declines every other modality', () => {
    expect(adapter.accepts('image', 'application/pdf')).toBe(false);
    expect(adapter.accepts('audio', 'application/pdf')).toBe(false);
    expect(adapter.accepts('sensor', 'application/pdf')).toBe(false);
  });
});

describe('DocumentTextAdapter.process', () => {
  it('extracts real text per page behind deterministic page markers', async () => {
    const pdf = buildPdf([
      textPage(['Invoice 2024-118', 'ACME Ltd']),
      textPage(['Total due 1234 EUR']),
    ]);
    const outputs = await adapter.process(inputFor(pdf));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.kind).toBe('text');
    expect(outputs[0]!.content).toBe(
      '[page 1 of 2]\nInvoice 2024-118\nACME Ltd\n\n[page 2 of 2]\nTotal due 1234 EUR',
    );
  });

  it('keeps reading order per page, not content-stream emission order', async () => {
    // The footer is emitted FIRST in the stream but sits lowest on the
    // page; geometry, not emission order, must decide.
    const stream =
      'BT /F1 12 Tf 72 100 Td (page footer) Tj ET\n' +
      'BT /F1 12 Tf 72 700 Td (document title) Tj ET\n';
    const outputs = await adapter.process(inputFor(buildPdf([stream])));
    expect(outputs[0]!.content).toBe('[page 1 of 1]\ndocument title\npage footer');
  });

  it('joins separated runs on one line with a space and touching runs without', async () => {
    // "Invoice" is ~38pt wide at 12pt: the Td of 60pt leaves a real gap,
    // while the TJ kern pulls the next run back onto the previous one.
    const stream =
      'BT /F1 12 Tf 72 700 Td (Invoice) Tj 60 0 Td (Number) Tj ET\n' +
      'BT /F1 12 Tf 72 680 Td [(Kern) 250 (ed)] TJ ET\n';
    const outputs = await adapter.process(inputFor(buildPdf([stream])));
    expect(outputs[0]!.content).toBe('[page 1 of 1]\nInvoice Number\nKerned');
  });

  it('is deterministic — identical bytes render byte-identical content', async () => {
    const pdf = buildPdf([textPage(['alpha beta']), textPage(['gamma'])]);
    const first = await adapter.process(inputFor(pdf));
    const second = await adapter.process(inputFor(pdf));
    expect(second[0]!.content).toBe(first[0]!.content);
  });

  it('never bleeds one document into the next (pdf2json pooled-buffer bug)', async () => {
    // Regression guard for pdf2json 4.0.3's parseBuffer rebuilding a
    // pooled Buffer from offset 0: without the detach, the SECOND parse
    // in a process returns the FIRST document's text or dies on the
    // xref. Distinct short documents (short ⇒ pooled) parsed back to
    // back must each come back as themselves.
    const docs = [
      buildPdf([textPage(['first document']), textPage(['first tail'])]),
      buildPdf([textPage(['second document'])]),
      buildPdf([textPage(['third document']), textPage(['third tail'])]),
    ];
    const rendered: string[] = [];
    for (const doc of docs) {
      const outputs = await adapter.process(inputFor(doc));
      rendered.push(outputs[0]!.content!);
    }
    expect(rendered[0]).toBe('[page 1 of 2]\nfirst document\n\n[page 2 of 2]\nfirst tail');
    expect(rendered[1]).toBe('[page 1 of 1]\nsecond document');
    expect(rendered[2]).toBe('[page 1 of 2]\nthird document\n\n[page 2 of 2]\nthird tail');
  });

  it('marks every page even when only some of them carry text', async () => {
    const blank = 'q 1 0 0 RG 10 10 100 100 re S Q\n';
    const pdf = buildPdf([textPage(['only page one speaks']), blank]);
    const outputs = await adapter.process(inputFor(pdf));
    expect(outputs[0]!.content).toBe('[page 1 of 2]\nonly page one speaks\n\n[page 2 of 2]');
  });
});

describe('DocumentTextAdapter failure modes', () => {
  const previousMax = process.env.EVIDENCE_MAX_BYTES;
  const previousDerived = process.env.EVIDENCE_DERIVED_MAX_BYTES;
  afterEach(() => {
    if (previousMax === undefined) delete process.env.EVIDENCE_MAX_BYTES;
    else process.env.EVIDENCE_MAX_BYTES = previousMax;
    if (previousDerived === undefined) delete process.env.EVIDENCE_DERIVED_MAX_BYTES;
    else process.env.EVIDENCE_DERIVED_MAX_BYTES = previousDerived;
  });

  it('refuses a scan with no text layer and names the missing capability', async () => {
    const blank = 'q 1 0 0 RG 10 10 100 100 re S Q\n';
    await expect(adapter.process(inputFor(buildPdf([blank, blank])))).rejects.toThrow(
      /no extractable text layer \(2 pages\).*OCR/s,
    );
  });

  it('fails honestly on an oversize blob instead of buffering it', async () => {
    const pdf = buildPdf([textPage(['anything at all'])]);
    process.env.EVIDENCE_MAX_BYTES = '32';
    await expect(adapter.process(inputFor(pdf))).rejects.toThrow(/exceed the evidence size cap/);
  });

  it('rejects rather than truncates when the text passes the derived cap', async () => {
    const pdf = buildPdf([textPage(['a reasonably long line of extracted text'])]);
    process.env.EVIDENCE_DERIVED_MAX_BYTES = '8';
    await expect(adapter.process(inputFor(pdf))).rejects.toThrow(/derived-output cap \(8 bytes\)/);
  });

  it('fails honestly on corrupt bytes instead of crashing or hanging', async () => {
    const junk = Buffer.from('%PDF-1.4 and then absolutely nothing valid at all');
    await expect(adapter.process(inputFor(junk))).rejects.toThrow();
  });

  it('fails honestly on a truncated PDF', async () => {
    const pdf = buildPdf([textPage(['truncate me'])]);
    await expect(adapter.process(inputFor(pdf.subarray(0, 60)))).rejects.toThrow();
  });

  it('names availability when the asset has no readable bytes', async () => {
    await expect(adapter.process(inputFor(null))).rejects.toThrow(/bytes are not readable/);
  });
});

describe('DocumentTextAdapter fingerprint discipline', () => {
  it('is stable across runs', () => {
    const fp = processorConfigFingerprint(adapter);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(processorConfigFingerprint(new DocumentTextAdapter())).toBe(fp);
  });

  it('pins the rendering contract in configParts', () => {
    expect(adapter.configParts()).toEqual(['render=page-marked-v1']);
  });

  it('forks the key when the rendering contract changes', () => {
    const retuned: ProcessorAdapter = {
      capability: adapter.capability,
      version: adapter.version,
      configParts: () => ['render=page-marked-v2'],
      accepts: () => true,
      process: () => Promise.resolve([]),
    };
    expect(processorConfigFingerprint(retuned)).not.toBe(processorConfigFingerprint(adapter));
  });

  it('does not collide with the plain-text passthrough under the same capability', () => {
    const passthrough: ProcessorAdapter = {
      capability: 'text',
      version: 'text-extraction-passthrough-v1',
      configParts: () => [],
      accepts: () => true,
      process: () => Promise.resolve([]),
    };
    expect(processorConfigFingerprint(passthrough)).not.toBe(processorConfigFingerprint(adapter));
  });
});
