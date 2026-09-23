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
    tabs: Array<{window: WindowId; title: string; selected: boolean}>;
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
    if (active && focused && (isAncestor(focused, con) || con.parent === focused.parent)) {
      return 'focused_inactive';
    }
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
      const tabs: DecorationPlan['titleRows'][number]['tabs'] = [];
      for (const child of con.children) {
        if (child.kind !== 'leaf') continue;
        const childInfo = windows.get(child.window);
        if (childInfo?.fullscreen) continue;
        tabs.push({
          window: child.window,
          title: windows.get(child.window)?.title ?? '',
          selected: child === con.focusedChild,
        });
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
