import {describe, expect, it} from 'vitest';
import {Tree} from '../../../src/tree/tree';
import type {MonitorId, WindowId} from '../../../src/tree/node';

/**
 * Round 1, M4: a seeded fuzz over `reconfigure` and the commands that re-home a workspace.
 *
 * The defect class this guards -- `undefined` in `tree.visible`, and its sibling, a live output owning
 * no workspace -- has been shipped twice in this plan and caught twice by *executing* code, never once
 * by reading it. Both are invariants of the whole model rather than of one code path, so they are
 * asserted here directly after every single step instead of being inferred from an ownership assertion
 * in some hand-built fixture.
 *
 * Seeded so a failure names a seed that reproduces it exactly, and bounded (300 seeds x 10 steps) so it
 * stays a unit test. It is discriminating: moving the `coverOutputs` repair ahead of `reconfigure`'s
 * claim pass fails it on the first seed.
 */
function rng(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1000000) / 1000000;
  };
}

/** Seven candidate outputs, so a live set can lose and gain several at once. */
const CANDIDATES: readonly MonitorId[] = [10, 20, 30, 40, 50, 60, 70];
const SEEDS = 300;
const STEPS = 10;

interface Desk {
  outputs: Array<{id: MonitorId; index: number}>;
  primary: MonitorId;
  count: number;
  pinned: Map<number, MonitorId>;
}

/** A live set of one to four outputs with randomised Mutter indices, a primary among them, and pins. */
function desk(next: () => number): Desk {
  const pool = [...CANDIDATES];
  const size = 1 + Math.floor(next() * 4);
  const chosen: MonitorId[] = [];
  for (let i = 0; i < size; i++) chosen.push(...pool.splice(Math.floor(next() * pool.length), 1));
  // Mutter's indices are a permutation of 0..n-1 and say nothing about which output is primary -- the
  // reporting desk really does report the television as index 0 and the primary as index 1.
  const indices = [...chosen.keys()];
  const outputs = chosen.map(id => ({
    id, index: indices.splice(Math.floor(next() * indices.length), 1)[0]!,
  }));
  const pinned = new Map<number, MonitorId>();
  const pins = Math.floor(next() * 3);
  for (let i = 0; i < pins; i++)
    pinned.set(Math.floor(next() * 6), CANDIDATES[Math.floor(next() * CANDIDATES.length)]!);
  return {
    outputs,
    primary: chosen[Math.floor(next() * chosen.length)]!,
    count: Math.floor(next() * 7),
    pinned,
  };
}

function violations(tree: Tree, live: readonly MonitorId[], windows: Set<WindowId>, where: string): string[] {
  const bad: string[] = [];
  if (tree.visible.size !== live.length)
    bad.push(`${where}: visible has ${tree.visible.size} entries for ${live.length} live outputs`);
  for (const output of live) {
    const shown = tree.visible.get(output);
    if (shown === undefined) { bad.push(`${where}: visible[${output}] is undefined`); continue; }
    if (!tree.workspaces.has(shown)) {
      bad.push(`${where}: visible[${output}] is workspace ${shown}, which does not exist`);
      continue;
    }
    if (tree.outputOf(shown) !== output)
      bad.push(`${where}: output ${output} shows workspace ${shown}, owned by ${tree.outputOf(shown)}`);
    if (tree.workspacesOn(output).length === 0) bad.push(`${where}: output ${output} owns no workspace`);
  }
  const liveSet = new Set(live);
  for (const [index, home] of tree.remembered()) {
    if (!tree.workspaces.has(index)) bad.push(`${where}: remembered workspace ${index} no longer exists`);
    // A memory whose output is attached again should have been spent bringing the workspace home.
    if (liveSet.has(home)) bad.push(`${where}: workspace ${index} still remembers live output ${home}`);
  }
  try {
    tree.check(windows);
  } catch (error) {
    bad.push(`${where}: check() threw: ${String(error)}`);
  }
  return bad;
}

describe('reconfigure fuzz', () => {
  it('never leaves an output showing nothing, whatever the hotplug sequence', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS && failures.length === 0; seed++) {
      const next = rng(seed);
      let live = desk(next);
      const tree = new Tree(live.count, live.outputs, live.primary, live.pinned);
      const windows = new Set<WindowId>();
      let nextWindow = 1;
      failures.push(...violations(tree, live.outputs.map(o => o.id), windows, `seed ${seed}: birth`));

      for (let step = 0; step < STEPS && failures.length === 0; step++) {
        const roll = next();
        const indices = [...tree.workspaces.keys()];
        const liveIds = live.outputs.map(o => o.id);
        let what = 'noop';
        if (roll < 0.5) {
          live = desk(next);
          tree.reconfigure(live.count, live.outputs, live.primary, live.pinned);
          what = `reconfigure to [${live.outputs.map(o => `${o.id}@${o.index}`).join(' ')}] primary ${live.primary} count ${live.count}`;
        } else if (roll < 0.65) {
          const window = nextWindow++;
          tree.insert(window, indices[Math.floor(next() * indices.length)]!);
          windows.add(window);
          what = `insert ${window}`;
        } else if (roll < 0.8) {
          const index = indices[Math.floor(next() * indices.length)]!;
          tree.showWorkspace(index);
          what = `showWorkspace ${index}`;
        } else if (roll < 0.95) {
          const output = liveIds[Math.floor(next() * liveIds.length)]!;
          tree.moveWorkspaceToOutput(output);
          what = `moveWorkspaceToOutput ${output}`;
        } else {
          tree.focusedOutput = liveIds[Math.floor(next() * liveIds.length)]!;
          what = `focusedOutput = ${tree.focusedOutput}`;
        }
        failures.push(...violations(
          tree, live.outputs.map(o => o.id), windows, `seed ${seed} step ${step} (${what})`));
      }
    }
    expect(failures).toEqual([]);
  });
});
