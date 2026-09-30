import {describe, expect, it} from 'vitest';
import {
  adoptOutput, birthAssignment, coverOutputs, effectiveWorkspaceCount, orderOutputs, reassignLost,
  resolveOutputArg, resolveShowOutput,
} from '../../../src/tree/outputs';
import type {MonitorId, Rect} from '../../../src/tree/node';

const rect = (x: number, y: number, width: number, height: number): Rect => ({x, y, width, height});
const desk = new Map<MonitorId, Rect>([[3, rect(0, 32, 3840, 1048)], [2, rect(3840, 28, 1920, 1052)]]);

describe('effectiveWorkspaceCount', () => {
  it('leaves the requested count alone when it already covers every output', () => {
    expect(effectiveWorkspaceCount(10, 2)).toBe(10);
  });

  it('raises the requested count to the output count when it falls short', () => {
    expect(effectiveWorkspaceCount(1, 3)).toBe(3);
  });

  it('leaves the requested count alone when it exactly matches the output count', () => {
    expect(effectiveWorkspaceCount(2, 2)).toBe(2);
  });
});

describe('orderOutputs', () => {
  it('puts the primary first, then ascending Mutter index', () => {
    // The reporter's desk: the primary (HDMI-1) is Mutter index 1, the television index 0.
    // Ordering by index alone would hand workspace I to the television.
    expect(orderOutputs([{id: 2, index: 0}, {id: 3, index: 1}], 3)).toEqual([3, 2]);
  });

  it('is stable for three outputs', () => {
    expect(orderOutputs([{id: 7, index: 2}, {id: 5, index: 0}, {id: 6, index: 1}], 6)).toEqual([6, 5, 7]);
  });

  it('throws when the primary is not among the outputs', () => {
    expect(() => orderOutputs([{id: 1, index: 0}], 9)).toThrow(/primary/);
  });
});

describe('birthAssignment', () => {
  it("gives workspace N to output N, i3's startup rule", () => {
    expect(birthAssignment([3, 2], 10, new Map())).toEqual(new Map([
      [0, 3], [1, 2], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3],
    ]));
  });

  it('assigns every workspace, so a workspace always has exactly one output', () => {
    const assignment = birthAssignment([3, 2], 10, new Map());
    for (let index = 0; index < 10; index++) expect(assignment.has(index)).toBe(true);
  });

  it('lets a pinned assignment win over the default', () => {
    // `workspace 3 output <television>` in the config.
    expect(birthAssignment([3, 2], 4, new Map([[2, 2]]))).toEqual(new Map([[0, 3], [1, 2], [2, 2], [3, 3]]));
  });

  it('ignores a pin naming an output that is not live, falling back to the default assignment', () => {
    // Index 1's unpinned default is output 2 (ordered[1]), not the primary (3) -- so this distinguishes
    // "falls back to what the unpinned rule would have chosen" from a buggy "always primary" that would
    // also satisfy the old assertion at index 2, where the unpinned default happened to be the primary.
    expect(birthAssignment([3, 2], 3, new Map([[1, 99]])).get(1)).toBe(2);
  });

  it('puts everything on the single output when there is only one', () => {
    expect(birthAssignment([3], 3, new Map())).toEqual(new Map([[0, 3], [1, 3], [2, 3]]));
  });
});

describe('resolveOutputArg', () => {
  it('resolves a direction through geometry', () => {
    expect(resolveOutputArg('right', desk, 3, 3, new Map())).toBe(2);
    expect(resolveOutputArg('right', desk, 2, 3, new Map())).toBeNull();
  });

  it('resolves primary', () => {
    expect(resolveOutputArg('primary', desk, 2, 3, new Map())).toBe(3);
  });

  it('resolves a connector name, case-insensitively', () => {
    const byName = new Map([['hdmi-1', 3], ['dp-1', 2]]);
    expect(resolveOutputArg({name: 'DP-1'}, desk, 3, 3, byName)).toBe(2);
  });

  it('returns null for a name matching no connector', () => {
    expect(resolveOutputArg({name: 'VGA-9'}, desk, 3, 3, new Map([['dp-1', 2]]))).toBeNull();
  });
});

describe('reassignLost', () => {
  it("moves a lost output's workspaces to the primary and leaves the others alone", () => {
    const before = new Map([[0, 3], [1, 2], [2, 3], [3, 2]]);
    expect(reassignLost(before, new Set([3]), 3)).toEqual(new Map([[0, 3], [1, 3], [2, 3], [3, 3]]));
  });

  it('is a no-op when every assigned output is still live', () => {
    const before = new Map([[0, 3], [1, 2]]);
    expect(reassignLost(before, new Set([3, 2]), 3)).toEqual(before);
  });

  it('survives every workspace living on the output that vanished', () => {
    const before = new Map([[0, 2], [1, 2], [2, 2]]);
    expect(reassignLost(before, new Set([3]), 3)).toEqual(new Map([[0, 3], [1, 3], [2, 3]]));
  });
});

describe('coverOutputs', () => {
  it('returns an already-covered assignment unchanged', () => {
    const assignment = new Map([[0, 3], [1, 2]]);
    expect(coverOutputs(assignment, [3, 2], new Map())).toEqual(assignment);
  });

  it('gives a needy output a workspace when a pin concentrated every workspace elsewhere', () => {
    const assignment = new Map(Array.from({length: 10}, (_, index) => [index, 3]));
    const repaired = coverOutputs(assignment, [3, 2], new Map());
    expect(repaired.get(9)).toBe(2);
    for (let index = 0; index < 9; index++) expect(repaired.get(index)).toBe(3);
  });

  it("never takes the donor's shown workspace when it has an alternative", () => {
    const assignment = new Map([[0, 10], [1, 10], [2, 10]]);
    const showing = new Map([[10, 2]]);
    const repaired = coverOutputs(assignment, [10, 20], showing);
    expect(repaired.get(2)).toBe(10);
    expect(repaired.get(1)).toBe(20);
  });

  it('covers two needy outputs out of three, each from the current largest owner', () => {
    const assignment = new Map(Array.from({length: 5}, (_, index) => [index, 1]));
    const repaired = coverOutputs(assignment, [1, 2, 3], new Map());
    expect(repaired.get(4)).toBe(2);
    expect(repaired.get(3)).toBe(3);
    expect(repaired.get(0)).toBe(1);
    expect(repaired.get(1)).toBe(1);
    expect(repaired.get(2)).toBe(1);
  });
});

describe('adoptOutput', () => {
  it('prefers the lowest-numbered workspace remembered on the returning output', () => {
    expect(adoptOutput(new Map([[1, 2], [4, 2]]), 2, new Map([[0, 3], [1, 3], [4, 3]]))).toBe(1);
  });

  it('falls back to the lowest-numbered workspace not already elsewhere', () => {
    expect(adoptOutput(new Map(), 2, new Map([[0, 3], [1, 3]]))).toBeNull();
  });

  it('ignores a remembered workspace that no longer exists', () => {
    expect(adoptOutput(new Map([[7, 2]]), 2, new Map([[0, 3]]))).toBeNull();
  });
});

/**
 * Task 19, D1: the controller's precedence, as a table. Each row differs from the one above it in
 * exactly the tier under test, so no row can pass by accident of a lower tier agreeing with it -- the
 * laptop 10 is the focused output throughout, and every other tier names 20 or 30 instead.
 */
describe('resolveShowOutput', () => {
  const live = new Set<MonitorId>([10, 20, 30]);
  const base = {occupied: false, current: 20, pin: undefined, remembered: undefined, focused: 10, live};

  it('rule 1: an occupied workspace keeps the output it is on', () => {
    expect(resolveShowOutput({...base, occupied: true, pin: 30, remembered: 30})).toBe(20);
  });

  it('rule 2: a config pin wins for an empty workspace', () => {
    expect(resolveShowOutput({...base, pin: 30, remembered: 20})).toBe(30);
  });

  it('rule 3: the memory wins for an empty, unpinned workspace whose output has come back', () => {
    expect(resolveShowOutput({...base, remembered: 30})).toBe(30);
  });

  it('rule 4: an empty, unpinned, unremembered workspace materialises on the focused output', () => {
    // And not on `current` (20), which is what the birth spread's surplus rule stored for it.
    expect(resolveShowOutput(base)).toBe(10);
  });

  it('falls through a tier naming an output that is not attached', () => {
    const away = new Set<MonitorId>([10]);
    expect(resolveShowOutput({...base, occupied: true, live: away})).toBe(10);
    expect(resolveShowOutput({...base, pin: 30, live: away})).toBe(10);
    expect(resolveShowOutput({...base, remembered: 30, live: away})).toBe(10);
  });
});
