import type {Direction, Layout} from '../commands/model';
import {descendDirection} from './focus';
import {
  attach,
  axis,
  detach,
  directionAxis,
  isForward,
  replace,
  type AllocateSplit,
  type Con,
  type SplitCon,
  type SplitLayout,
} from './node';

export function splitCon(
  con: Con,
  orientation: 'h' | 'v' | 'toggle',
  allocate: AllocateSplit,
): Con {
  const layout = splitLayout(con, orientation);

  if (con.kind === 'split' && con.root) {
    if (con.children.length <= 1) {
      setSplitLayout(con, layout);
      return con;
    }
    return wrapRootChildren(con, layout, allocate);
  }

  const parent = con.parent;
  if (!parent) return con;
  if (parent.children.length === 1 && isSplitLayout(parent.layout)) {
    setSplitLayout(parent, layout);
    return con;
  }

  const wrapper = allocate(layout);
  replace(parent, con, wrapper);
  attach(wrapper, con, 0);
  return con;
}

export function setLayout(con: Con, layout: Layout, allocate: AllocateSplit): Con {
  const target = con.kind === 'split' ? con : con.parent;
  if (!target) return con;

  if (target.root && !isSplitLayout(layout)) {
    if (target.children.length === 0) return con;
    if (!isSplitLayout(target.layout)) throw new Error('root must use a split layout');
    const wrapper = wrapRootChildren(target, layout, allocate);
    wrapper.lastSplitLayout = target.layout;
    return con === target ? wrapper : con;
  }

  target.layout = layout;
  if (isSplitLayout(layout)) target.lastSplitLayout = layout;
  return con;
}

export function toggleLayout(
  con: Con,
  cycle: 'split' | 'all' | readonly Layout[],
  allocate: AllocateSplit,
): Con {
  if (Array.isArray(cycle) && cycle.length === 0)
    throw new Error('layout toggle list must not be empty');

  const target = con.kind === 'split' ? con : con.parent;
  if (!target) return con;
  const layouts = cycle === 'split'
    ? splitCycle(target)
    : cycle === 'all'
      ? (['splith', 'splitv', 'tabbed', 'stacked'] as const)
      : cycle;
  const current = layouts.indexOf(target.layout);
  const next = layouts[current === -1 ? 0 : (current + 1) % layouts.length];
  return setLayout(con, next, allocate);
}

export function moveCon(con: Con, direction: Direction): boolean {
  const wanted = directionAxis(direction);
  let same = matching(con.parent, wanted);
  if (!same) return false;

  if (same === con.parent) {
    const index = same.children.indexOf(con);
    const siblingIndex = index + (isForward(direction) ? 1 : -1);
    const sibling = same.children[siblingIndex];
    if (sibling) {
      if (sibling.kind === 'leaf') {
        same.children[index] = sibling;
        same.children[siblingIndex] = con;
        return true;
      }

      const target = descendDirection(sibling, direction);
      if (!target?.parent) return false;
      const parent = target.parent;
      const after = axis(parent.layout) !== wanted || !isForward(direction);
      const targetIndex = parent.children.indexOf(target);
      detach(con);
      attach(parent, con, targetIndex + (after ? 1 : 0));
      return true;
    }

    if (same.root) return false;
    same = matching(same.parent, wanted);
    if (!same) return false;
  }

  let above = con;
  while (above.parent !== same) {
    if (!above.parent) return false;
    above = above.parent;
  }
  const index = same.children.indexOf(above);
  detach(con);
  attach(same, con, index + (isForward(direction) ? 1 : 0));
  return true;
}

function matching(start: SplitCon | null, wanted: 'h' | 'v'): SplitCon | null {
  for (let parent = start; parent; parent = parent.parent) {
    if (axis(parent.layout) === wanted) return parent;
  }
  return null;
}

function splitLayout(con: Con, orientation: 'h' | 'v' | 'toggle'): SplitLayout {
  if (orientation === 'h') return 'splith';
  if (orientation === 'v') return 'splitv';
  const reference = con.parent ?? (con.kind === 'split' && con.root ? con : null);
  return reference && axis(reference.layout) === 'h' ? 'splitv' : 'splith';
}

function splitCycle(target: SplitCon): readonly Layout[] {
  if (target.layout === 'tabbed' || target.layout === 'stacked')
    return [target.layout, target.lastSplitLayout];
  return ['splith', 'splitv'];
}

function isSplitLayout(layout: Layout): layout is SplitLayout {
  return layout === 'splith' || layout === 'splitv';
}

function setSplitLayout(con: SplitCon, layout: SplitLayout): void {
  con.layout = layout;
  con.lastSplitLayout = layout;
}

function wrapRootChildren(
  root: SplitCon,
  layout: Layout,
  allocate: AllocateSplit,
): SplitCon {
  const wrapper = allocate(layout);
  wrapper.children = [...root.children];
  wrapper.percents = [...root.percents];
  wrapper.focusedChild = root.focusedChild;
  for (const child of wrapper.children) child.parent = wrapper;
  root.children = [wrapper];
  root.percents = [1];
  root.focusedChild = wrapper;
  wrapper.parent = root;
  return wrapper;
}
