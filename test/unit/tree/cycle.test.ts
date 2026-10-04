import {describe, expect, it} from 'vitest';
import {cycleWorkspace} from '../../../src/tree/cycle';
import {Tree} from '../../../src/tree/tree';

describe('cycleWorkspace', () => {
  // The fixture the whole change turns on: ten workspaces configured, three in the cycle. Numeric
  // neighbours and i3's "next existing workspace" agree on 0 -> 1 and 1 -> 2, so only the ends can
  // tell them apart -- `next` from the last member is 3 (which does not exist) under the old rule and
  // the first member under i3's.
  const members = [0, 1, 2];

  it('wraps next from the last member round to the first', () => {
    expect(cycleWorkspace(members, 2, 'next')).toBe(0);
  });

  it('wraps prev from the first member round to the last', () => {
    expect(cycleWorkspace(members, 0, 'prev')).toBe(2);
  });

  it('skips the gaps between members instead of stepping one index at a time', () => {
    // 0, 4 and 9 of ten: a numeric neighbour of 0 is 1, which is not in the cycle at all.
    expect(cycleWorkspace([0, 4, 9], 0, 'next')).toBe(4);
    expect(cycleWorkspace([0, 4, 9], 4, 'next')).toBe(9);
    expect(cycleWorkspace([0, 4, 9], 9, 'next')).toBe(0);
    expect(cycleWorkspace([0, 4, 9], 9, 'prev')).toBe(4);
    expect(cycleWorkspace([0, 4, 9], 0, 'prev')).toBe(9);
  });

  it('stays put when the cycle holds only the workspace the user is on', () => {
    expect(cycleWorkspace([3], 3, 'next')).toBe(3);
    expect(cycleWorkspace([3], 3, 'prev')).toBe(3);
  });

  it('has no answer for an empty cycle', () => {
    expect(cycleWorkspace([], 0, 'next')).toBeNull();
    expect(cycleWorkspace([], 0, 'prev')).toBeNull();
  });

  it('accepts members in any order and ignores duplicates', () => {
    // The caller unions two collections; nothing about `visible.values()` promises an order.
    expect(cycleWorkspace([9, 0, 4, 4], 0, 'next')).toBe(4);
    expect(cycleWorkspace([9, 0, 4, 4], 9, 'next')).toBe(0);
  });

  it('places a current index outside the cycle between its neighbours', () => {
    // Not reachable through `Tree.cycleMembers` -- the visible workspace is always a member -- but a
    // total function needs an answer, and "the next member after where you are" is the only one that
    // does not lose the direction the user asked for.
    expect(cycleWorkspace([0, 4, 9], 6, 'next')).toBe(9);
    expect(cycleWorkspace([0, 4, 9], 6, 'prev')).toBe(4);
    expect(cycleWorkspace([0, 4, 9], 11, 'next')).toBe(0);
    expect(cycleWorkspace([0, 4, 9], -1, 'prev')).toBe(9);
  });
});

describe('Tree.cycleMembers', () => {
  it('is the union of the occupied workspaces and the ones on screen', () => {
    const t = new Tree(10, [{id: 0, index: 0}, {id: 1, index: 1}], 0);
    // Outputs 0 and 1 show workspaces 0 and 1; put a window on 5 so it is occupied but parked.
    t.insert(1, 5);
    expect(t.cycleMembers()).toEqual([0, 1, 5]);
  });

  it('counts a workspace holding only floating windows (D5)', () => {
    // `occupied()` deliberately treats a floating-only workspace as occupied; the cycle inherits that,
    // so a workspace the user can see windows on is never skipped by `workspace next`.
    const t = new Tree(10, [{id: 0, index: 0}], 0);
    t.addFloating(1, 7);
    expect(t.cycleMembers()).toEqual([0, 7]);
  });

  it('always contains the workspace the user is on, even with nothing open anywhere', () => {
    const t = new Tree(10, [{id: 0, index: 0}], 0);
    expect(t.cycleMembers()).toEqual([0]);
  });
});
