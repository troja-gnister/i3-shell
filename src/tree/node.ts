import type {Direction, Layout} from '../commands/model';

export type WindowId = number;
export type NodeId = number;
export type MonitorId = number;
export type Axis = 'h' | 'v';
export type SplitLayout = 'splith' | 'splitv';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LeafCon {
  kind: 'leaf';
  id: NodeId;
  parent: SplitCon | null;
  window: WindowId;
}

export interface SplitCon {
  kind: 'split';
  id: NodeId;
  parent: SplitCon | null;
  root: boolean;
  layout: Layout;
  lastSplitLayout: SplitLayout;
  children: Con[];
  percents: number[];
  focusedChild: Con | null;
}

export type Con = LeafCon | SplitCon;

export interface WorkspaceCon {
  index: number;
  monitors: Map<MonitorId, SplitCon>;
  focusedCon: Con | null;
  floating: WindowId[];
  focusedFloating: WindowId | null;
}

export type Selection =
  | {kind: 'tiled'; con: Con}
  | {kind: 'floating'; window: WindowId}
  | null;

export type AllocateSplit = (layout: Layout, root?: boolean) => SplitCon;

export function axis(layout: Layout): Axis {
  return layout === 'splitv' || layout === 'stacked' ? 'v' : 'h';
}

export function directionAxis(direction: Direction): Axis {
  return direction === 'up' || direction === 'down' ? 'v' : 'h';
}

export function isForward(direction: Direction): boolean {
  return direction === 'right' || direction === 'down';
}

export function* walk(con: Con): Generator<Con> {
  yield con;
  if (con.kind === 'split') {
    for (const child of con.children) yield* walk(child);
  }
}

export function* leaves(con: Con): Generator<LeafCon> {
  for (const current of walk(con)) {
    if (current.kind === 'leaf') yield current;
  }
}

export function descendFocused(con: Con): LeafCon | null {
  let current = con;
  while (current.kind === 'split') {
    const child = current.focusedChild && current.children.includes(current.focusedChild)
      ? current.focusedChild
      : current.children[0];
    if (!child) return null;
    current = child;
  }
  return current;
}

export function rootOf(con: Con): SplitCon {
  let current: Con = con;
  const visited = new Set<Con>();
  while (current.parent) {
    if (visited.has(current)) throw new Error('container parent cycle');
    visited.add(current);
    current = current.parent;
  }
  if (current.kind !== 'split' || !current.root)
    throw new Error('container is not attached to a root split');
  return current;
}

export function attach(parent: SplitCon, child: Con, index: number): void {
  assertValidWeights(parent);
  if (!Number.isInteger(index) || index < 0 || index > parent.children.length)
    throw new Error('attachment index is out of range');
  assertDetachedChild(parent, child);

  const count = parent.children.length + 1;
  parent.percents = parent.percents.map(percent => percent * (count - 1) / count);
  parent.children.splice(index, 0, child);
  parent.percents.splice(index, 0, 1 / count);
  child.parent = parent;
  parent.focusedChild ??= child;
}

export function detach(child: Con): SplitCon {
  const parent = child.parent;
  if (!parent) throw new Error('cannot detach a container without a parent');
  assertValidWeights(parent);
  const index = parent.children.indexOf(child);
  if (index === -1) throw new Error('child is absent from its parent');

  parent.children.splice(index, 1);
  parent.percents.splice(index, 1);
  const total = parent.percents.reduce((sum, percent) => sum + percent, 0);
  parent.percents = parent.percents.map(percent => percent / total);
  if (parent.focusedChild === child) parent.focusedChild = parent.children[0] ?? null;
  child.parent = null;
  return parent;
}

export function replace(parent: SplitCon, oldChild: Con, newChild: Con): void {
  assertValidWeights(parent);
  const index = parent.children.indexOf(oldChild);
  if (index === -1) throw new Error('old child is absent from parent');
  if (oldChild.parent !== parent) throw new Error('old child is not attached to parent');
  assertDetachedChild(parent, newChild);

  parent.children[index] = newChild;
  if (parent.focusedChild === oldChild) parent.focusedChild = newChild;
  oldChild.parent = null;
  newChild.parent = parent;
}

export function focusChain(con: Con): void {
  let child = con;
  while (child.parent) {
    const parent = child.parent;
    parent.focusedChild = child;
    child = parent;
  }
}

function assertValidWeights(parent: SplitCon): void {
  if (parent.percents.length !== parent.children.length)
    throw new Error('percentage length must match children');
  if (parent.children.length === 0) return;
  for (const percent of parent.percents) {
    if (!Number.isFinite(percent)) throw new Error('percentage must be finite');
    if (percent <= 0) throw new Error('percentage must be positive');
  }
  const total = parent.percents.reduce((sum, percent) => sum + percent, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error('percentage sum must equal one');
}

function assertDetachedChild(parent: SplitCon, child: Con): void {
  if (child.kind === 'split' && child.root) throw new Error('cannot attach a root split');
  if (child.parent) throw new Error('child must be detached');
  if (wouldCreateCycle(parent, child)) throw new Error('container cycle');
  if (child.kind === 'split') assertValidWeights(child);
}

function wouldCreateCycle(parent: SplitCon, child: Con): boolean {
  const visited = new Set<Con>();
  let current: Con | null = parent;
  while (current) {
    if (current === child) return true;
    if (visited.has(current)) throw new Error('container parent cycle');
    visited.add(current);
    current = current.parent;
  }
  return false;
}
