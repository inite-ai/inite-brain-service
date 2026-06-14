/**
 * Unit-test for classifyIntentLocally + shouldSkipLLM — the two
 * deterministic decision functions that gate the LLM call.
 * Punctuation-only intent classifier; conservative all-pass skip gate.
 */
import {
  classifyIntentLocally,
  shouldSkipLLM,
} from '../src/admin/chat-router.service';

describe('classifyIntentLocally', () => {
  it('empty / whitespace → tell, 0 (never skip)', () => {
    expect(classifyIntentLocally('')).toEqual({
      intent: 'tell',
      confidence: 0,
    });
    expect(classifyIntentLocally('   ')).toEqual({
      intent: 'tell',
      confidence: 0,
    });
  });

  it('trailing `?` → ask, 0.95', () => {
    expect(classifyIntentLocally('where does Maria live?')).toEqual({
      intent: 'ask',
      confidence: 0.95,
    });
    expect(classifyIntentLocally('Maria lives in Berlin?')).toEqual({
      intent: 'ask',
      confidence: 0.95,
    });
  });

  it('declarative (no `?`) → tell, 0.7', () => {
    expect(classifyIntentLocally('Maria is the CTO at Acme')).toEqual({
      intent: 'tell',
      confidence: 0.7,
    });
    expect(classifyIntentLocally('She moved to Berlin')).toEqual({
      intent: 'tell',
      confidence: 0.7,
    });
  });

  it('wh-shaped sentence without `?` falls through to tell', () => {
    // Trade-off acknowledged in the docstring: an unpunctuated wh-question
    // is treated as a tell-default and falls back to the LLM.
    expect(classifyIntentLocally('where Maria lives')).toEqual({
      intent: 'tell',
      confidence: 0.7,
    });
  });

  it('language-agnostic — only the universal `?` matters', () => {
    expect(classifyIntentLocally('где живёт Мария?').confidence).toBe(0.95);
    expect(classifyIntentLocally('Мария переехала в Берлин').confidence).toBe(
      0.7,
    );
  });

  it('trailing whitespace after `?` still counts as `?`', () => {
    expect(classifyIntentLocally('Where is she?   ').confidence).toBe(0.95);
  });
});

const span = (text: string, start = 0) => ({
  text,
  start,
  end: start + text.length,
});

const stubMention = (canonical: string) => ({
  canonical,
  span: span(canonical),
});

const stubHint = (predicateId: string, similarity = 0.6) => ({
  predicateId,
  similarity,
  triggerSpan: span('q'),
});

const stubCollapse = () => ({
  pattern: 'moved to',
  replacement: 'lives in',
  span: span('moved to'),
});

describe('shouldSkipLLM', () => {
  it('refuses skip when intent confidence is below floor', () => {
    expect(
      shouldSkipLLM({
        intent: 'ask',
        intentConfidence: 0.7,
        intentConfidenceFloor: 0.85,
        localMentions: [stubMention('Maria')],
        localHints: [stubHint('address')],
        localCollapses: [],
      }),
    ).toEqual({ skip: false, reason: 'intent_confidence_low' });
  });

  it('refuses skip when no mentions resolved', () => {
    expect(
      shouldSkipLLM({
        intent: 'ask',
        intentConfidence: 0.95,
        intentConfidenceFloor: 0.85,
        localMentions: [],
        localHints: [stubHint('address')],
        localCollapses: [],
      }),
    ).toEqual({ skip: false, reason: 'no_mentions_resolved' });
  });

  it('refuses skip on ask when no predicate hints', () => {
    expect(
      shouldSkipLLM({
        intent: 'ask',
        intentConfidence: 0.95,
        intentConfidenceFloor: 0.85,
        localMentions: [stubMention('Maria')],
        localHints: [],
        localCollapses: [],
      }),
    ).toEqual({ skip: false, reason: 'no_predicate_hints' });
  });

  it('refuses skip on tell when no cached collapses', () => {
    expect(
      shouldSkipLLM({
        intent: 'tell',
        intentConfidence: 0.7,
        intentConfidenceFloor: 0.7,
        localMentions: [stubMention('Maria')],
        localHints: [],
        localCollapses: [],
      }),
    ).toEqual({ skip: false, reason: 'tell_no_cached_collapses' });
  });

  it('skips ASK when all locals present', () => {
    expect(
      shouldSkipLLM({
        intent: 'ask',
        intentConfidence: 0.95,
        intentConfidenceFloor: 0.85,
        localMentions: [stubMention('Maria')],
        localHints: [stubHint('address')],
        localCollapses: [],
      }),
    ).toEqual({ skip: true, reason: 'all_local_ask' });
  });

  it('skips TELL when mentions + cached collapses present', () => {
    expect(
      shouldSkipLLM({
        intent: 'tell',
        intentConfidence: 0.7,
        intentConfidenceFloor: 0.7,
        localMentions: [stubMention('Maria')],
        localHints: [],
        localCollapses: [stubCollapse()],
      }),
    ).toEqual({ skip: true, reason: 'all_local_tell' });
  });
});
