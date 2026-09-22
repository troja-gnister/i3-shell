import {describe, expect, it} from 'vitest';
import {SessionState} from '../../../src/shell/sessionState';

describe('SessionState', () => {
  it('exposes the seeded lock state without firing a transition', () => {
    const transitions: string[] = [];
    const state = new SessionState(true,
      () => transitions.push('locked'),
      () => transitions.push('unlocked'));

    expect(state.isLocked).toBe(true);
    expect(transitions).toEqual([]);
  });

  it('fires once for each lock edge and ignores repeated native updates', () => {
    const transitions: string[] = [];
    const state = new SessionState(false,
      () => transitions.push('locked'),
      () => transitions.push('unlocked'));

    state.update(true);
    state.update(true);
    state.update(false);
    state.update(false);

    expect(state.isLocked).toBe(false);
    expect(transitions).toEqual(['locked', 'unlocked']);
  });
});
