/**
 * GATE: the changefeed→audit_event mirror must never carry raw PII
 * values. It records WHICH predicate changed on WHICH entity, not the
 * sensitive VALUE. This is also the structural defence for the GDPR
 * forget race (a re-materialised post-image is already redacted).
 */
import {
  redactAfterImage,
  REDACTED,
} from '../src/audit/changefeed-redaction';

describe('redactAfterImage', () => {
  it('redacts fact PII value fields but keeps structural fields', () => {
    const out = redactAfterImage({
      id: 'knowledge_fact:abc',
      entityId: 'knowledge_entity:xyz',
      predicate: 'home_address',
      object: '221B Baker Street, London',
      objectMeta: { geo: 'secret' },
      confidence: 0.9,
      status: 'active',
      validFrom: '2026-01-01',
      embedding: [0.1, 0.2, 0.3],
    });
    // PII values gone
    expect(out.object).toBe(REDACTED);
    expect(out.objectMeta).toBe(REDACTED);
    // structural fields preserved
    expect(out.id).toBe('knowledge_fact:abc');
    expect(out.entityId).toBe('knowledge_entity:xyz');
    expect(out.predicate).toBe('home_address');
    expect(out.confidence).toBe(0.9);
    expect(out.status).toBe('active');
    // embedding bloat dropped entirely
    expect('embedding' in out).toBe(false);
  });

  it('redacts entity name + aliases + the lowercase mirror + external refs', () => {
    const out = redactAfterImage({
      id: 'knowledge_entity:e1',
      type: 'person',
      canonicalName: 'Jane Doe',
      canonicalNameLc: 'jane doe', // the stored computed mirror — must redact
      aliases: ['JD', 'Janie'],
      externalRefs: { crm: 'secret-id' },
    });
    expect(out.canonicalName).toBe(REDACTED);
    expect(out.canonicalNameLc).toBe(REDACTED);
    expect(out.aliases).toBe(REDACTED);
    expect(out.externalRefs).toBe(REDACTED);
    expect(out.type).toBe('person');
  });

  it('redacts unknown/future fields by default (allowlist, not denylist)', () => {
    const out = redactAfterImage({ id: 'x', someNewPiiField: 'leak me' });
    expect(out.someNewPiiField).toBe(REDACTED);
    expect(out.id).toBe('x');
  });

  it('leaves null/absent PII fields untouched (no spurious [redacted])', () => {
    const out = redactAfterImage({ id: 'x', object: null });
    expect(out.object).toBeNull();
  });
});
