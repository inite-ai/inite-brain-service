import { CommitWriterService } from '../src/documents/commit-writer.service';

/**
 * The judge (an LLM call per mention) is asked for a document's mentions
 * at once; the ladder consumes the answers in order, and once a mention
 * creates an entity the rest are asked live — the outcome is exactly the
 * sequential one (a later mention may be the entity just created).
 */
describe('CommitWriter entity resolution with prejudged verdicts', () => {
  it('asks every unanchored mention ahead, concurrently; after a creation the ladder asks live', async () => {
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    const entities = {
      prejudge: async (p: { e: { name: string } }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        asked.push(p.e.name);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return null;
      },
      resolveOrCreateNamedEntity: async (p: {
        e: { name: string };
        prejudged?: Promise<string | null>;
        onStep?: (s: string) => void;
      }) => {
        const usedAhead = p.prejudged !== undefined;
        if (p.e.name === 'Acme') p.onStep?.('created');
        return `knowledge_entity:${p.e.name}:${usedAhead ? 'ahead' : 'live'}`;
      },
    };
    const writer = new CommitWriterService(
      undefined as never,
      entities as never,
      undefined as never,
    );
    const merge = {
      entities: [
        { key: 'k1', name: 'Acme', type: 'customer' },
        { key: 'k2', name: 'Acme Corp', type: 'customer' },
        { key: 'k3', name: 'Ana', type: 'staff', known: 'e1' },
      ],
      facts: [],
      relations: [],
    };
    const ids = await (
      writer as unknown as {
        resolveEntities: (db: unknown, p: unknown) => Promise<Map<string, string>>;
      }
    ).resolveEntities({}, { doc: { id: 'd', vertical: 'v', meta: {} }, merge });
    // Pinned by the extractor (`known`) → never asked ahead.
    expect(asked.sort()).toEqual(['Acme', 'Acme Corp']);
    expect(peak).toBe(2);
    // Acme used its ahead verdict and created; Acme Corp (after the
    // creation) was asked live — it may be the entity just created.
    expect(ids.get('k1')).toBe('knowledge_entity:Acme:ahead');
    expect(ids.get('k2')).toBe('knowledge_entity:Acme Corp:live');
  });
});
