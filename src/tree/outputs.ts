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
 * output" is total and needs no separate notion of being placed. `workspace N` moves an unshown
 * workspace to the focused output regardless of what this assigned it (see the Tree's `showWorkspace`).
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
