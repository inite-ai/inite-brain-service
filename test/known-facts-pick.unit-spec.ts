/**
 * Which known facts a turn is shown (pickKnownFacts): the ones it talks
 * about first, then the newest. The newest-12 cut alone hid
 * `queue_backend: Redis Streams` from the turn that replaced it on the
 * memory-fitness memory, so both values stayed current.
 */
import { pickKnownFacts } from '../src/ai/extractor-internals/memory-context';

const f = (predicate: string, object: string) => ({ predicate, object });

describe('pickKnownFacts', () => {
  const newestFirst = [
    ...Array.from({ length: 15 }, (_, i) => f(`decision_${i}`, `today item ${i}`)),
    f('deploy_target', 'Fly.io'),
    f('queue_backend', 'Redis Streams'),
  ];

  it('shows a fact the turn names by its attribute, however old', () => {
    const shown = pickKnownFacts(
      newestFirst,
      'Decision: we switch the queue backend to NATS JetStream.',
      12,
    );
    expect(shown).toHaveLength(12);
    expect(shown).toContainEqual(f('queue_backend', 'Redis Streams'));
    expect(shown).not.toContainEqual(f('deploy_target', 'Fly.io'));
  });

  it('shows a fact the turn names by its old value', () => {
    const shown = pickKnownFacts(newestFirst, 'Moving off Fly.io next week.', 12);
    expect(shown).toContainEqual(f('deploy_target', 'Fly.io'));
  });

  it('fills the rest with the newest, in their order', () => {
    const shown = pickKnownFacts(newestFirst, 'Nothing in particular.', 3);
    expect(shown).toEqual(newestFirst.slice(0, 3));
  });
});
