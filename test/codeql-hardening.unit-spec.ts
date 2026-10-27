import { isCodeSymbolShaped } from '../src/ingest/code-alias';
import { decodeHtmlEntities, htmlToText } from '../src/common/html-text';
import { mergeDocumentMeta } from '../src/documents/document-meta';
import { webhookRequestOf } from '../src/source-plane/records/source-webhook.controller';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Pins the fixes for the CodeQL findings in shipped code (2026-10-27
 * scorecard): each case is the input the alert described.
 */
describe('CodeQL hardening', () => {
  it('the PascalCase symbol test is linear on a run of capitals (js/redos)', () => {
    const started = Date.now();
    expect(isCodeSymbolShaped(`${'A'.repeat(200)}!`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it('the PascalCase symbol test keeps its language', () => {
    expect(isCodeSymbolShaped('WebhookDispatcher')).toBe(true);
    expect(isCodeSymbolShaped('HTTPServer')).toBe(true);
    expect(isCodeSymbolShaped('Readme')).toBe(false);
    expect(isCodeSymbolShaped('webhookDispatcher')).toBe(false);
    expect(isCodeSymbolShaped('WEBHOOK')).toBe(false);
  });

  it('an escaped entity decodes once, not twice (js/double-escaping)', () => {
    expect(decodeHtmlEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    expect(decodeHtmlEntities('a &amp; b &lt; c')).toBe('a & b < c');
  });

  it('a script end tag with trailing space still ends the script (js/bad-tag-filter)', () => {
    const { body } = htmlToText('<p>kept</p><script>alert(1)</script ><p>also</p>');
    expect(body).not.toContain('alert');
    expect(body).toContain('kept');
    expect(body).toContain('also');
  });

  it('caller metadata cannot set the merged object prototype', () => {
    const caller = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<
      string,
      unknown
    >;
    const out = mergeDocumentMeta(caller, undefined) ?? {};
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    expect(out.ok).toBe(1);
  });

  it('a webhook header or query key named __proto__ stays data', () => {
    const req = {
      headers: JSON.parse('{"__proto__": "x", "X-Sig": "abc"}') as Record<string, string>,
      query: JSON.parse('{"__proto__": "y", "token": "t"}') as Record<string, string>,
      body: {},
      protocol: 'https',
      get: () => 'example.test',
      originalUrl: '/hook',
    } as unknown as RawBodyRequest<Request>;
    const out = webhookRequestOf(req);
    expect(out.headers['x-sig']).toBe('abc');
    expect(out.query.token).toBe('t');
    expect(Object.getPrototypeOf(out.query)).toBeNull();
  });
});
