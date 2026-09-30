import type {Direction} from '../commands/model';
import {neighbourMonitor} from './monitors';
import type {MonitorId, Rect} from './node';

/** An output as the topology knows it: a stable id plus Mutter's enumeration index. */
export interface OutputRef {
  id: MonitorId;
  index: number;
}

/** The argument shared by `focus output`, `move container to output` and `move workspace to output`. */
export type OutputArg = Direction | 'primary' | {name: string};

/**
 * Outputs in the order workspaces are handed out: **primary first**, then ascending Mutter index.
 *
 * The primary must come first because "the primary display is workspace one" is the behaviour being
 * asked for. Mutter's index order is not that: on the reporting desk the primary is index 1 and the
 * television index 0, so sorting by index alone would put workspace I on the television.
 */
export function orderOutputs(outputs: readonly OutputRef[], primary: MonitorId): MonitorId[] {
  if (!outputs.some(output => output.id === primary))
    throw new Error(`primary output ${primary} is not among the outputs`);
  const rest = outputs.filter(output => output.id !== primary).sort((a, b) => a.index - b.index);
  return [primary, ...rest.map(output => output.id)];
}

/**
 * How many workspaces a tree really has: at least one per output.
 *
 * i3 creates one workspace per output at startup whatever the config names, and the invariant that
 * every output shows exactly one of its own workspaces is only total if this holds. Without it, an
 * output with no workspace of its own would have to show another output's — laying one root into two
 * different work areas.
 */
export function effectiveWorkspaceCount(requested: number, outputCount: number): number {
  return Math.max(requested, outputCount);
}

/**
 * i3's startup rule: workspace N to output N, for as many outputs as exist.
 *
 * Every workspace gets an output — the surplus go to the primary — so "a workspace has exactly one
 * output" is total and needs no separate notion of being placed. For the surplus that output is pure
 * bookkeeping (coverage and the bars read it); it is not an affinity, because `resolveShowOutput` below
 * decides where an unshown workspace materialises at switch time. Task 19, D1: that distinction is the
 * whole fix, and it is why this line still hands the surplus to the primary.
 */
export function birthAssignment(
  ordered: readonly MonitorId[],
  workspaceCount: number,
  pinned: ReadonlyMap<number, MonitorId>,
): Map<number, MonitorId> {
  if (ordered.length === 0) throw new Error('at least one output is required');
  const live = new Set(ordered);
  const primary = ordered[0]!;
  const assignment = new Map<number, MonitorId>();
  for (let index = 0; index < workspaceCount; index++) {
    const pin = pinned.get(index);
    // A pin naming a connector that is not attached is ignored rather than fatal: a config written
    // on another machine must still work here.
    if (pin !== undefined && live.has(pin)) {
      assignment.set(index, pin);
      continue;
    }
    assignment.set(index, ordered[index] ?? primary);
  }
  return assignment;
}

/**
 * Which output `workspace N` shows a workspace on, when no output is showing it already.
 *
 * Task 19, D1. The birth spread gives every workspace a stored output because coverage and the bars
 * need one (`birthAssignment` above hands the surplus to the primary), but for an *empty* workspace
 * that stored output is bookkeeping, not an affinity: real i3 has no such workspace until you switch to
 * it, and `workspace N` materialises it on the focused output. Treating the stored output as an
 * affinity is what left eight of the user's ten workspaces bound to the laptop panel, so that every
 * `$mod+N` switched the panel and took the keyboard with it while they were looking at the external
 * display.
 *
 * The controller's precedence, in order:
 *
 * 1. **Occupied** -- a workspace holding windows keeps the output it is on. A number key must never
 *    move a window between displays; i3 takes you to the workspace, it does not fetch it.
 * 2. **Config pin** -- `workspace N output X` wins for an empty workspace, on every switch and not
 *    merely at birth. An empty workspace has nothing to lose by honouring it, which is why rule 1
 *    outranks it: a pinned workspace the user has since moved, with windows on it, stays moved.
 * 3. **Memory** -- Task 16's record of where an unplug found a workspace, for one whose output has
 *    come back.
 * 4. **Focused output** -- an empty, unpinned, unremembered workspace materialises where the user is
 *    looking. This is the rule the defect was missing.
 *
 * Every tier is filtered through `live`, including the occupied workspace's own output: the result is
 * written straight into `Tree.visible`, and an output that is not attached has no work area to lay a
 * workspace out in. Coverage is not this function's business -- `coverOutputs` stays the single
 * authority for that.
 */
export function resolveShowOutput(state: {
  /** Does the workspace hold any window, tiled or floating? */
  occupied: boolean;
  /** The workspace's stored output. */
  current: MonitorId;
  pin: MonitorId | undefined;
  remembered: MonitorId | undefined;
  focused: MonitorId;
  live: ReadonlySet<MonitorId>;
}): MonitorId {
  const {occupied, current, pin, remembered, focused, live} = state;
  if (occupied && live.has(current)) return current;
  if (pin !== undefined && live.has(pin)) return pin;
  if (remembered !== undefined && live.has(remembered)) return remembered;
  return focused;
}

/**
 * Repair an assignment so every live output owns at least one workspace.
 *
 * The clamp guarantees enough workspaces exist; it does not guarantee they cover every output. A
 * workspace moved to the primary when its output vanished does not come back on replug, and a
 * `workspace N output …` pin can concentrate several workspaces on one output. Either leaves an output
 * owning nothing, and an output that owns nothing cannot show one of its own.
 *
 * Always succeeds: with K live outputs and W ≥ K workspaces, if one output owns none then the other
 * ≤ K−1 own all W > K−1, so some output owns ≥ 2 and can spare one. Taking from an owner of ≥ 2 leaves
 * it ≥ 1, so the pass is monotone and terminates.
 *
 * `showing` names the workspace each output currently displays, so the donor gives up one it is not
 * displaying where it can — taking the shown one would move what the user is looking at.
 */
export function coverOutputs(
  assignment: ReadonlyMap<number, MonitorId>,
  ordered: readonly MonitorId[],
  showing: ReadonlyMap<MonitorId, number>,
): Map<number, MonitorId> {
  const result = new Map(assignment);
  const owned = (output: MonitorId): number[] =>
    [...result].filter(([, owner]) => owner === output).map(([workspace]) => workspace).sort((a, b) => a - b);

  for (const needy of ordered) {
    if (owned(needy).length > 0) continue;

    // Donor: the output owning the most workspaces, ties broken by lowest id. Guaranteed to own at
    // least two — see the proof above — so it always has one to spare.
    const counts = new Map<MonitorId, number>();
    for (const owner of result.values()) counts.set(owner, (counts.get(owner) ?? 0) + 1);
    const mostOwned = Math.max(...counts.values());
    const donor = [...counts]
      .filter(([, count]) => count === mostOwned)
      .map(([output]) => output)
      .sort((a, b) => a - b)[0]!;

    const donorWorkspaces = owned(donor);
    const highest = donorWorkspaces.at(-1)!;
    const taken = highest !== showing.get(donor) ? highest : donorWorkspaces.at(-2)!;
    result.set(taken, needy);
  }

  return result;
}

/** `left|right|up|down` through geometry, `primary`, or a connector name. Null = no such output. */
export function resolveOutputArg(
  arg: OutputArg,
  areas: ReadonlyMap<MonitorId, Rect>,
  from: MonitorId,
  primary: MonitorId,
  byName: ReadonlyMap<string, MonitorId>,
): MonitorId | null {
  if (arg === 'primary') return primary;
  if (typeof arg === 'object') return byName.get(arg.name.toLowerCase()) ?? null;
  return neighbourMonitor(areas, from, arg);
}

/** Workspaces on an output that has gone move to the primary; their roots are untouched. */
export function reassignLost(
  assignment: ReadonlyMap<number, MonitorId>,
  live: ReadonlySet<MonitorId>,
  primary: MonitorId,
): Map<number, MonitorId> {
  const next = new Map(assignment);
  for (const [workspace, output] of assignment)
    if (!live.has(output)) next.set(workspace, primary);
  return next;
}

/**
 * Which workspace a returning output should show: the lowest-numbered one remembered on it that still
 * exists. Null means nothing was remembered, and the caller picks by its own rule.
 */
export function adoptOutput(
  remembered: ReadonlyMap<number, MonitorId>,
  gained: MonitorId,
  assignment: ReadonlyMap<number, MonitorId>,
): number | null {
  const candidates = [...remembered]
    .filter(([workspace, output]) => output === gained && assignment.has(workspace))
    .map(([workspace]) => workspace)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}
