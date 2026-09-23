import {descendFocused} from '../tree/node';
import type {Con, NodeId, Rect, SplitCon, WindowId} from '../tree/node';
import type {WindowInfo} from './model';

export type BorderState = 'focused' | 'focused_inactive' | 'unfocused' | 'urgent';

export interface DecorationPlan {
  borders: Array<{window: WindowId; rect: Rect; state: BorderState; width: number}>;
  frames: Array<{nodeId: NodeId; rect: Rect}>;
  titleRows: Array<{
    nodeId: NodeId;
    rect: Rect;
    rowHeight: number;
    layout: 'tabbed' | 'stacked';
    tabs: Array<{nodeId: NodeId; window: WindowId | null; title: string; selected: boolean}>;
  }>;
}

export interface DecorationInput {
  roots: ReadonlyArray<{root: SplitCon; active: boolean}>;
  rects: ReadonlyMap<Con, Rect>;
  windows: ReadonlyMap<WindowId, WindowInfo>;
  focused: Con | null;
  rowHeight: number;
  borderWidth: number;
  borderOverrides: ReadonlyMap<WindowId, number>;
}

/**
 * True when any leaf under `con` is fullscreen.
 *
 * Suppression is decided per monitor root, not per container: a fullscreen
 * window owns its whole monitor (main spec 19 leaves its geometry to Mutter),
 * so every decoration on that monitor would be drawn over it -- not only the
 * title row of the container that happens to hold it.
 *
 * That "over it" is literal, and it is why this is a root-level rule. Every
 * decoration is stacked explicitly, on every apply: a border immediately above
 * its own window actor, and a frame or title row above every window actor in
 * `global.window_group` (src/shell/decorations.ts). So a tab bar on a
 * container nowhere near the fullscreen window would still paint across it --
 * deterministically, not by accident of the last restack -- which is exactly
 * what this suppression prevents.
 */
function hasFullscreenLeaf(con: Con, windows: DecorationInput['windows']): boolean {
  if (con.kind === 'leaf') return windows.get(con.window)?.fullscreen === true;
  return con.children.some(child => hasFullscreenLeaf(child, windows));
}

/** The top of `con`'s tree: the monitor root it was reached from. */
function rootOf(con: Con): Con {
  let current: Con = con;
  while (current.parent) current = current.parent;
  return current;
}

/** True when `ancestor` is a strict ancestor of `node` (walking `.parent`). */
function isAncestor(ancestor: Con, node: Con): boolean {
  let current: Con | null = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

export function decorationPlan(input: DecorationInput): DecorationPlan {
  const {roots, rects, windows, focused, rowHeight, borderWidth, borderOverrides} = input;
  const borders: DecorationPlan['borders'] = [];
  const frames: DecorationPlan['frames'] = [];
  const titleRows: DecorationPlan['titleRows'] = [];

  function borderState(con: Con, active: boolean): BorderState {
    if (con === focused) return 'focused';
    if (!active || !focused) return 'unfocused';
    if (isAncestor(focused, con)) return 'focused_inactive';
    // "The other leaves of the focused container" only applies when the
    // selection itself is a leaf — a SplitCon selection ($mod+a) is made
    // visible by `isAncestor` alone above, and an unrelated sibling of that
    // selected container must not inherit its state just because they share
    // a grandparent.
    if (focused.kind === 'leaf' && con.parent === focused.parent) return 'focused_inactive';
    return 'unfocused';
  }

  function visit(con: Con, active: boolean): void {
    const rect = rects.get(con);

    if (con.kind === 'leaf') {
      if (!rect) return;
      const info = windows.get(con.window);
      if (!info || info.minimized) return;

      const width = borderOverrides.get(con.window) ?? borderWidth;
      borders.push({window: con.window, rect, state: borderState(con, active), width});
      return;
    }

    if (rect && (con.layout === 'tabbed' || con.layout === 'stacked')) {
      const tabs: DecorationPlan['titleRows'][number]['tabs'] = [];
      for (const child of con.children) {
        const selected = child === con.focusedChild;
        if (child.kind === 'leaf') {
          const childInfo = windows.get(child.window);
          tabs.push({nodeId: child.id, window: child.window, title: childInfo?.title ?? '', selected});
          continue;
        }
        // A nested container's tab shows its own focused descendant's
        // window title, the way i3 titles a stacked/tabbed child container.
        const descendant = descendFocused(child);
        const title = descendant ? windows.get(descendant.window)?.title ?? '' : '';
        tabs.push({nodeId: child.id, window: null, title, selected});
      }
      if (tabs.length > 0) {
        titleRows.push({nodeId: con.id, rect, rowHeight, layout: con.layout, tabs});
      }
    }

    for (const child of con.children) visit(child, active);
  }

  /** A monitor whose root holds a fullscreen leaf gets nothing drawn on it. */
  const owned = new Set<Con>();
  for (const {root, active} of roots) {
    if (hasFullscreenLeaf(root, windows)) {
      owned.add(root);
      continue;
    }
    visit(root, active);
  }

  if (focused && focused.kind === 'split' && !owned.has(rootOf(focused))) {
    const rect = rects.get(focused);
    if (rect) frames.push({nodeId: focused.id, rect});
  }

  return {borders, frames, titleRows};
}
