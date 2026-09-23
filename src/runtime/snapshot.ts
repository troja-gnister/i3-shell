import type {Layout} from '../commands/model';
import type {Con, MonitorId, NodeId, Rect, SplitLayout, WindowId} from '../tree/node';
import type {Tree} from '../tree/tree';
import type {Topology, WindowInfo} from './model';

export type NodeSnapshot =
  | {kind: 'leaf'; id: NodeId; window: WindowId; title: string; wmClass: string | null; rect: Rect | null}
  | {kind: 'split'; id: NodeId; layout: Layout; lastSplitLayout: SplitLayout; rect: Rect | null;
     children: NodeSnapshot[]; percents: number[]; focusedChild: NodeId | null; rowHeight: number};
export interface TreeSnapshot {
  version: 1;
  revision: number;
  ready: boolean;
  activeWorkspace: number;
  workspaces: Array<{
    index: number;
    selected: {kind: 'tiled'; nodeId: NodeId} | {kind: 'floating'; window: WindowId} | null;
    floating: WindowId[];
    monitors: Array<{id: MonitorId; workArea: Rect | null; root: NodeSnapshot}>;
  }>;
}
export interface WindowSnapshot extends WindowInfo {
  state: 'tiled' | 'floating' | 'minimized';
  expectedRect: Rect | null;
  generation: number | null;
  stubborn: boolean;
}

/** Detached values only: callers cannot mutate the tree, topology or reconciliation state. */
export function serializeTree(
  tree: Tree, topology: Topology, rects: ReadonlyMap<Con, Rect>,
  windows: ReadonlyMap<WindowId, WindowInfo>, revision: number, rowHeight: number,
): TreeSnapshot {
  const node = (con: Con): NodeSnapshot => {
    const rect = rects.get(con);
    const common = {id: con.id, rect: rect ? {...rect} : null};
    if (con.kind === 'leaf') {
      const info = windows.get(con.window);
      return {...common, kind: 'leaf', window: con.window, title: info?.title ?? '', wmClass: info?.wmClass ?? null};
    }
    return {...common, kind: 'split', layout: con.layout, lastSplitLayout: con.lastSplitLayout,
      children: con.children.map(node), percents: [...con.percents], focusedChild: con.focusedChild?.id ?? null,
      rowHeight: con.layout === 'tabbed' ? rowHeight : con.layout === 'stacked' ? rowHeight * con.children.length : 0};
  };
  return {version: 1, revision, ready: true, activeWorkspace: tree.activeWorkspace,
    workspaces: [...tree.workspaces.values()].map(ws => {
      const selection = tree.selection(ws.index);
      return {index: ws.index, selected: selection?.kind === 'tiled'
        ? {kind: 'tiled', nodeId: selection.con.id} : selection ? {...selection} : null,
      floating: [...ws.floating], monitors: [...ws.monitors].map(([id, root]) => {
        const area = topology.workAreas.get(ws.index)?.get(id);
        return {id, workArea: area ? {...area} : null, root: node(root)};
      })};
    })};
}
