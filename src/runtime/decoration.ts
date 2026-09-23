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
      if (!info || info.fullscreen || info.minimized) return;

      const width = borderOverrides.get(con.window) ?? borderWidth;
      borders.push({window: con.window, rect, state: borderState(con, active), width});
      return;
    }

    if (rect && (con.layout === 'tabbed' || con.layout === 'stacked')) {
      // Spec 3.2: a fullscreen leaf costs its *container* the whole title row,
      // not just its own tab. A fullscreen window owns the monitor, so a row
      // that survived with one tab fewer would simply be drawn on top of it --
      // the chrome-over-fullscreen this spec and main spec 19 both forbid.
      //
      // It also keeps the engine and the renderer in step: layoutWithRects
      // reserves one row per *child* of a stacked container, while the
      // renderer divides that band by the number of *tabs* it was handed. A
      // row with a tab missing would under-fill a band already reserved.
      const fullscreen = con.children.some(
        child => child.kind === 'leaf' && windows.get(child.window)?.fullscreen);
      if (fullscreen) {
        for (const child of con.children) visit(child, active);
        return;
      }

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

  for (const {root, active} of roots) {
    visit(root, active);
  }

  if (focused && focused.kind === 'split') {
    const rect = rects.get(focused);
    if (rect) frames.push({nodeId: focused.id, rect});
  }

  return {borders, frames, titleRows};
}
