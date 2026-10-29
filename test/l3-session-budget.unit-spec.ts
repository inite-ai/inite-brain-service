import { selectL3Sessions } from '../src/synthesize/l3-escalation';

describe('selectL3Sessions', () => {
  it('pending sessions come first and count against the budget', () => {
    expect(selectL3Sessions(['p1'], ['r1', 'r2', 'r3'], 3)).toEqual(['p1', 'r1', 'r2']);
  });

  it('a pending session that also ranks is read once', () => {
    expect(selectL3Sessions(['r2'], ['r1', 'r2', 'r3'], 3)).toEqual(['r2', 'r1', 'r3']);
  });

  it('pending sessions are never dropped, even past the budget', () => {
    expect(selectL3Sessions(['p1', 'p2', 'p3', 'p4'], ['r1'], 3)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});
