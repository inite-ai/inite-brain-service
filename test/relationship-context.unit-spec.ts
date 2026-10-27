/**
 * relationship_context's shape (src/entities/relationship-context.ts):
 * the pack's facts and the person's boundaries, read for an agent about
 * to speak — what is owed first, and a state only while it still holds.
 */
import { shapeRelationshipContext } from '../src/entities/relationship-context';

const now = new Date('2026-10-27T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
const hoursAhead = (h: number) => new Date(now.getTime() + h * 3600_000).toISOString();

describe('relationship context', () => {
  it('sorts the facts into what an agent needs, each with its factId', () => {
    const ctx = shapeRelationshipContext({
      userId: 'ana',
      name: 'Ana',
      now,
      rows: [
        {
          id: 'f:1',
          predicate: 'instruction',
          object: 'Never talk about weight',
          validFrom: hoursAgo(300),
          about: 'Ana',
        },
        {
          id: 'f:2',
          predicate: 'relationship__tone_preference',
          object: 'short and direct',
          validFrom: hoursAgo(200),
        },
        {
          id: 'f:3',
          predicate: 'relationship__open_thread',
          object: 'sweets at the office',
          validFrom: hoursAgo(100),
        },
        {
          id: 'f:4',
          predicate: 'relationship__helped',
          object: 'washed fruit in the fridge',
          validFrom: hoursAgo(90),
        },
        {
          id: 'f:5',
          predicate: 'relationship__did_not_help',
          object: 'weekly goal list',
          validFrom: hoursAgo(80),
        },
      ],
    });
    expect(ctx.name).toBe('Ana');
    expect(ctx.boundaries).toEqual([
      { factId: 'f:1', text: 'Never talk about weight', about: 'Ana', since: hoursAgo(300) },
    ]);
    expect(ctx.tone?.factId).toBe('f:2');
    expect(ctx.openThreads.map((t) => t.factId)).toEqual(['f:3']);
    expect(ctx.whatHelped.map((t) => t.factId)).toEqual(['f:4']);
    expect(ctx.whatDidNotHelp.map((t) => t.factId)).toEqual(['f:5']);
    expect(ctx.state).toEqual({ known: false });
  });

  it('puts what is owed first: a commitment past its due date is overdue', () => {
    const ctx = shapeRelationshipContext({
      userId: 'ana',
      now,
      rows: [
        {
          id: 'c:later',
          predicate: 'relationship__commitment',
          object: 'send the recipe',
          validFrom: hoursAgo(1),
          expectedUntil: hoursAhead(48),
          about: 'Coach',
        },
        {
          id: 'c:open',
          predicate: 'relationship__commitment',
          object: 'walk after lunch',
          validFrom: hoursAgo(2),
          about: 'Ana',
        },
        {
          id: 'c:due',
          predicate: 'relationship__commitment',
          object: 'ask how the dinner went',
          validFrom: hoursAgo(72),
          expectedUntil: hoursAgo(24),
          about: 'Coach',
        },
      ],
    });
    expect(ctx.commitments.map((c) => [c.factId, c.overdue])).toEqual([
      ['c:due', true],
      ['c:later', false],
      ['c:open', false],
    ]);
    expect(ctx.commitments[0]).toMatchObject({ about: 'Coach', due: hoursAgo(24) });
    expect(ctx.commitments[2]).not.toHaveProperty('due');
  });

  it('knows the state only while it holds — its span, else about a day', () => {
    const state = (row: { validFrom: string; expectedUntil?: string }) =>
      shapeRelationshipContext({
        userId: 'ana',
        now,
        rows: [
          { id: 's:1', predicate: 'relationship__stated_affect', object: 'exhausted', ...row },
        ],
      }).state;
    expect(state({ validFrom: hoursAgo(2) })).toMatchObject({ known: true, ageHours: 2 });
    expect(state({ validFrom: hoursAgo(30) })).toEqual({
      known: false,
      last: { factId: 's:1', text: 'exhausted', saidAt: hoursAgo(30), ageHours: 30 },
    });
    // "this week" said three days ago still holds
    expect(state({ validFrom: hoursAgo(72), expectedUntil: hoursAhead(48) })).toMatchObject({
      known: true,
      holdsUntil: hoursAhead(48),
    });
  });

  it('the newest said state wins, whatever order the rows came in', () => {
    const ctx = shapeRelationshipContext({
      userId: 'ana',
      now,
      rows: [
        {
          id: 'old',
          predicate: 'relationship__stated_affect',
          object: 'exhausted',
          validFrom: hoursAgo(20),
        },
        {
          id: 'new',
          predicate: 'relationship__stated_affect',
          object: 'excited',
          validFrom: hoursAgo(2),
        },
      ],
    });
    expect(ctx.state).toMatchObject({ known: true, factId: 'new' });
  });
});

describe('relationship context — hypotheses', () => {
  it('keeps a guess put to the person apart from what they said, by its outcome', () => {
    const ctx = shapeRelationshipContext({
      userId: 'ana',
      now,
      rows: [
        {
          id: 'h:1',
          predicate: 'relationship__hypothesis',
          object: 'coach: anxious about work',
          validFrom: hoursAgo(5),
        },
        {
          id: 'h:2',
          predicate: 'relationship__hypothesis_rejected',
          object: 'coach: long meetings',
          validFrom: hoursAgo(50),
        },
        {
          id: 'h:3',
          predicate: 'relationship__hypothesis_confirmed',
          object: 'coach: sleep',
          validFrom: hoursAgo(60),
        },
      ],
    });
    expect(ctx.hypotheses).toEqual({
      open: [{ factId: 'h:1', text: 'coach: anxious about work', since: hoursAgo(5) }],
      confirmed: [{ factId: 'h:3', text: 'coach: sleep', since: hoursAgo(60) }],
      rejected: [{ factId: 'h:2', text: 'coach: long meetings', since: hoursAgo(50) }],
    });
    expect(ctx.state).toEqual({ known: false });
  });
});

describe('relationship context — an answered guess is not open', () => {
  const rows = (openAt: string) => [
    {
      id: 'h:open',
      predicate: 'relationship__hypothesis',
      object: 'Coach hypothesizes that Ana snacks more at night on days with long meetings',
      validFrom: openAt,
    },
    {
      id: 'h:rej',
      predicate: 'relationship__hypothesis_rejected',
      object: "Coach's hypothesis that Ana snacks more at night on days with long meetings",
      validFrom: hoursAgo(5),
    },
    {
      id: 'h:other',
      predicate: 'relationship__hypothesis',
      object: 'Coach hypothesized that Ana is anxious about work',
      validFrom: hoursAgo(5),
    },
  ];

  it('drops the open row its own rejection repeats (battery r8, 2026-10-27)', () => {
    const ctx = shapeRelationshipContext({ userId: 'ana', now, rows: rows(hoursAgo(5)) });
    expect(ctx.hypotheses.open.map((h) => h.factId)).toEqual(['h:other']);
    expect(ctx.hypotheses.rejected.map((h) => h.factId)).toEqual(['h:rej']);
  });

  it('keeps a guess raised again more than a day after it was answered', () => {
    const ctx = shapeRelationshipContext({ userId: 'ana', now, rows: rows(hoursAhead(30)) });
    expect(ctx.hypotheses.open.map((h) => h.factId).sort()).toEqual(['h:open', 'h:other']);
  });
});

describe('relationship context — when a commitment falls due', () => {
  it('reads the day it is for, owed through the end of that day', () => {
    const ctx = shapeRelationshipContext({
      userId: 'ana',
      now,
      rows: [
        // said six days ago, for four days ago
        {
          id: 'c:past',
          predicate: 'relationship__commitment',
          object: 'ask how the dinner went',
          validFrom: hoursAgo(144),
          scheduledDay: '2026-10-23',
        },
        // for today: not overdue until today is over
        {
          id: 'c:today',
          predicate: 'relationship__commitment',
          object: 'send the plan',
          validFrom: hoursAgo(30),
          scheduledDay: '2026-10-27',
        },
      ],
    });
    expect(ctx.commitments.map((c) => [c.factId, c.overdue, c.due])).toEqual([
      ['c:past', true, '2026-10-24T00:00:00.000Z'],
      ['c:today', false, '2026-10-28T00:00:00.000Z'],
    ]);
  });
});
