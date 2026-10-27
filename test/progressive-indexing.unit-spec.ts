/**
 * Progressive indexing and the remote parser (W6), pure parts: which
 * words of a question are worth matching a filename against, and how a
 * parser service's answer is read.
 */
import { termsOf } from '../src/source-plane/source-deepen.service';
import { textOf } from '../src/evidence/processing/adapters/remote-parser.adapter';
import { RemoteParserAdapter } from '../src/evidence/processing/adapters/remote-parser.adapter';

describe('termsOf — what a question offers a filename', () => {
  it('drops the words every filename would match', () => {
    expect(termsOf('what is the runbook for the payments gateway?')).toEqual([
      'runbook',
      'payments',
      'gateway',
    ]);
  });

  it('a question of nothing but stopwords matches nothing', () => {
    expect(termsOf('what is it about?')).toEqual([]);
    expect(termsOf('')).toEqual([]);
  });

  it('keeps hyphens and digits, folds case, and stops at six terms', () => {
    expect(termsOf('Q3-2026 ledger migration Riga warehouse sensors invoice 4471')).toEqual([
      'q3-2026',
      'ledger',
      'migration',
      'riga',
      'warehouse',
      'sensors',
    ]);
  });
});

describe('the remote parser’s answer', () => {
  it('prefers markdown, then text, then content', () => {
    expect(textOf('{"markdown":"# T","text":"T"}')).toBe('# T');
    expect(textOf('{"text":"plain"}')).toBe('plain');
    expect(textOf('{"content":"last"}')).toBe('last');
  });

  it('anything that is not a JSON object carrying one of them is nothing', () => {
    expect(textOf('not json')).toBeNull();
    expect(textOf('"a string"')).toBeNull();
    expect(textOf('{"pages":[]}')).toBeNull();
    expect(textOf('{"text":42}')).toBeNull();
  });
});

describe('the remote parser accepts only what an operator named', () => {
  const adapter = new RemoteParserAdapter();
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts nothing while it is off, or configured without a URL', () => {
    delete process.env.EVIDENCE_PARSER_REMOTE;
    expect(adapter.accepts('document', 'application/pdf')).toBe(false);
    process.env.EVIDENCE_PARSER_REMOTE = '1';
    delete process.env.EVIDENCE_PARSER_REMOTE_URL;
    expect(adapter.accepts('document', 'application/pdf')).toBe(false);
  });

  it('takes the media types named and leaves the rest to the local floor', () => {
    process.env.EVIDENCE_PARSER_REMOTE = '1';
    process.env.EVIDENCE_PARSER_REMOTE_URL = 'https://parse.example.test/v1';
    expect(adapter.accepts('document', 'application/pdf')).toBe(true);
    expect(adapter.accepts('document', 'text/plain')).toBe(false);
    // Not a document at all.
    expect(adapter.accepts('image', 'application/pdf')).toBe(false);
    process.env.EVIDENCE_PARSER_REMOTE_MEDIA_TYPES = 'text/html, application/pdf';
    expect(adapter.accepts('document', 'text/html')).toBe(true);
  });

  it('the service and its mode ride the fingerprint; the bearer never does', () => {
    process.env.EVIDENCE_PARSER_REMOTE_URL = 'https://parse.example.test/v1';
    process.env.EVIDENCE_PARSER_REMOTE_PROFILE = 'tables';
    process.env.EVIDENCE_PARSER_REMOTE_TOKEN = 'secret-token';
    const parts = adapter.configParts();
    expect(parts).toEqual(['url=https://parse.example.test/v1', 'profile=tables']);
    expect(parts.join('|')).not.toContain('secret-token');
  });
});
