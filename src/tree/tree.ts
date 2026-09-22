import type {Direction, Layout} from '../commands/model';
import {nextFocus, type Wrapping} from './focus';
import {resizeCon, type ResizeRequest} from './resize';
import {moveCon, setLayout, splitCon, toggleLayout} from './operations';
import {
  attach,
  descendFocused,
  detach,
  focusChain,
  replace,
  type AllocateSplit,
  type Con,
  type LeafCon,
  type MonitorId,
  type Rect,
  type Selection,
  type SplitCon,
  type WindowId,
  type WorkspaceCon,
} from './node';

const splitLayouts = new Set<Layout>(['splith', 'splitv']);
const layouts = new Set<Layout>(['splith', 'splitv', 'tabbed', 'stacked']);

export class Tree {
  readonly workspaces: Map<number, WorkspaceCon>;
  activeWorkspace: number;
  private nextNodeId = 1;

  allocateSplit: AllocateSplit = (layout, root = false) => {
    if (!layouts.has(layout)) throw new Error(`invalid layout: ${String(layout)}`);
    return {
      kind: 'split',
      id: this.nextNodeId++,
      parent: null,
      root,
      layout,
      lastSplitLayout: layout === 'splitv' ? 'splitv' : 'splith',
      children: [],
      percents: [],
      focusedChild: null,
    };
  };

  constructor(workspaceCount: number, monitors: readonly MonitorId[]) {
    assertInteger(workspaceCount, 'workspace count');
    if (workspaceCount < 1 || workspaceCount > 36)
      throw new Error('workspace count must be between 1 and 36');
    if (monitors.length === 0) throw new Error('at least one monitor is required');
    const uniqueMonitors = new Set<MonitorId>();
    for (const monitor of monitors) {
      assertNonnegativeInteger(monitor, 'monitor id');
      if (uniqueMonitors.has(monitor)) throw new Error(`duplicate monitor id ${monitor}`);
      uniqueMonitors.add(monitor);
    }

    this.workspaces = new Map();
    this.activeWorkspace = 0;
    for (let index = 0; index < workspaceCount; index++) {
      const roots = new Map<MonitorId, SplitCon>();
      for (const monitor of monitors) roots.set(monitor, this.allocateSplit('splith', true));
      this.workspaces.set(index, {
        index,
        monitors: roots,
        focusedCon: roots.values().next().value ?? null,
        floating: [],
        focusedFloating: null,
      });
    }
  }

  workspace(index: number): WorkspaceCon {
    assertNonnegativeInteger(index, 'workspace index');
    const workspace = this.workspaces.get(index);
    if (!workspace) throw new Error(`unknown workspace ${index}`);
    return workspace;
  }

  root(workspace: number, monitor: MonitorId): SplitCon {
    assertNonnegativeInteger(monitor, 'monitor id');
    const root = this.workspace(workspace).monitors.get(monitor);
    if (!root) throw new Error(`unknown monitor ${monitor} on workspace ${workspace}`);
    return root;
  }

  find(window: WindowId): LeafCon | null {
    assertWindowId(window);
    for (const workspace of this.workspaces.values()) {
      for (const root of workspace.monitors.values()) {
        const found = findLeaf(root, window);
        if (found) return found;
      }
    }
    return null;
  }

  owner(con: Con): WorkspaceCon {
    for (const workspace of this.workspaces.values()) {
      for (const root of workspace.monitors.values()) {
        if (contains(root, con)) return workspace;
      }
    }
    throw new Error(`container ${con.id} is not owned by this tree`);
  }

  location(window: WindowId): {workspace: number; monitor: MonitorId | null; floating: boolean} | null {
    assertWindowId(window);
    for (const [workspaceIndex, workspace] of this.workspaces) {
      for (const [monitor, root] of workspace.monitors) {
        if (findLeaf(root, window)) return {workspace: workspaceIndex, monitor, floating: false};
      }
      if (workspace.floating.includes(window))
        return {workspace: workspaceIndex, monitor: null, floating: true};
    }
    return null;
  }

  selection(workspace = this.activeWorkspace): Selection {
    const ws = this.workspace(workspace);
    return ws.focusedFloating !== null
      ? {kind: 'floating', window: ws.focusedFloating}
      : ws.focusedCon ? {kind: 'tiled', con: ws.focusedCon} : null;
  }

  focus(direction: Direction, wrapping: Wrapping): LeafCon | null {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return null;
    const target = nextFocus(selection.con, direction, wrapping);
    if (target) this.select(target);
    return target;
  }

  focusParent(): Con | null {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return null;
    const target = selection.con.parent;
    if (target) this.select(target);
    return target;
  }

  focusChild(): Con | null {
    const selection = this.selection();
    if (selection?.kind !== 'tiled' || selection.con.kind === 'leaf') return null;
    const target = selection.con.focusedChild;
    if (target) this.select(target);
    return target;
  }

  split(orientation: 'h' | 'v' | 'toggle'): void {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return;
    const workspace = this.owner(selection.con);
    const target = splitCon(selection.con, orientation, this.allocateSplit);
    this.select(target);
    this.normalizeWorkspace(workspace, undefined, ancestorChain(target.parent));
  }

  setLayout(layout: Layout): void {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return;
    const workspace = this.owner(selection.con);
    const target = setLayout(selection.con, layout, this.allocateSplit);
    this.select(target);
    this.normalizeWorkspace(workspace, undefined, ancestorChain(target.parent));
  }

  toggleLayout(cycle: 'split' | 'all' | readonly Layout[]): void {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return;
    const workspace = this.owner(selection.con);
    const target = toggleLayout(selection.con, cycle, this.allocateSplit);
    this.select(target);
    this.normalizeWorkspace(workspace, undefined, ancestorChain(target.parent));
  }

  move(direction: Direction): boolean {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return false;
    const workspace = this.owner(selection.con);
    if (!moveCon(selection.con, direction)) return false;
    this.select(selection.con);
    this.normalizeWorkspace(workspace, undefined, ancestorChain(selection.con.parent));
    return true;
  }

  resize(request: ResizeRequest, rectangles: ReadonlyMap<Con, Rect>): boolean {
    const selection = this.selection();
    if (selection?.kind !== 'tiled') return false;
    return resizeCon(selection.con, request, rectangles);
  }

  select(con: Con): void {
    const workspace = this.owner(con);
    workspace.focusedCon = con;
    workspace.focusedFloating = null;
    focusChain(con);
  }

  selectFloating(window: WindowId): void {
    assertWindowId(window);
    for (const workspace of this.workspaces.values()) {
      const index = workspace.floating.indexOf(window);
      if (index === -1) continue;
      workspace.floating.splice(index, 1);
      workspace.floating.unshift(window);
      workspace.focusedFloating = window;
      return;
    }
    throw new Error(`floating window ${window} is not owned by this tree`);
  }

  activateWorkspace(index: number): void {
    this.workspace(index);
    this.activeWorkspace = index;
  }

  insert(window: WindowId, workspace: number, monitor: MonitorId): LeafCon {
    assertWindowId(window);
    const ws = this.workspace(workspace);
    const root = this.root(workspace, monitor);
    if (this.location(window)) throw new Error(`window ${window} is already tracked`);

    const selected = ws.focusedCon && contains(root, ws.focusedCon)
      ? ws.focusedCon
      : descendFocused(root) ?? root;
    const parent = selected.kind === 'leaf' ? selected.parent : selected;
    if (!parent) throw new Error(`selected container ${selected.id} has no insertion parent`);
    const index = selected.kind === 'leaf'
      ? parent.children.indexOf(selected) + 1
      : parent.children.length;
    const leaf: LeafCon = {
      kind: 'leaf',
      id: this.nextNodeId++,
      parent: null,
      window,
    };
    attach(parent, leaf, index);
    ws.focusedCon = leaf;
    ws.focusedFloating = null;
    focusChain(leaf);
    return leaf;
  }

  remove(window: WindowId): void {
    assertWindowId(window);
    for (const workspace of this.workspaces.values()) {
      const floatingIndex = workspace.floating.indexOf(window);
      if (floatingIndex !== -1) {
        workspace.floating.splice(floatingIndex, 1);
        if (workspace.focusedFloating === window)
          workspace.focusedFloating = workspace.floating[0] ?? null;
        return;
      }

      for (const root of workspace.monitors.values()) {
        const leaf = findLeaf(root, window);
        if (!leaf) continue;
        const fallback = workspace.focusedCon === leaf ? ancestorChain(leaf.parent) : [];
        if (workspace.focusedCon === leaf) workspace.focusedCon = null;
        detach(leaf);
        this.normalizeWorkspace(workspace, undefined, fallback);
        return;
      }
    }
  }

  normalize(live?: ReadonlySet<WindowId>): void {
    for (const workspace of this.workspaces.values())
      this.normalizeWorkspace(workspace, live, []);
  }

  check(live?: ReadonlySet<WindowId>): void {
    if (!this.workspaces.has(this.activeWorkspace))
      throw new Error(`active workspace ${this.activeWorkspace} does not exist`);
    if (this.workspaces.size < 1 || this.workspaces.size > 36)
      throw new Error('workspace count must be between 1 and 36');

    const seenCons = new Set<Con>();
    const nodeIds = new Set<number>();
    const windowIds = new Set<WindowId>();

    for (const [workspaceIndex, workspace] of this.workspaces) {
      assertNonnegativeInteger(workspaceIndex, 'workspace index');
      if (workspace.index !== workspaceIndex)
        throw new Error(`workspace ${workspaceIndex} has mismatched index ${workspace.index}`);
      if (workspace.monitors.size === 0)
        throw new Error(`workspace ${workspaceIndex} has no monitor roots`);
      const owned = new Set<Con>();

      for (const [monitor, root] of workspace.monitors) {
        assertNonnegativeInteger(monitor, 'monitor id');
        inspectCon(root, null, true, seenCons, nodeIds, windowIds, owned);
      }

      if (workspace.focusedCon !== null && !owned.has(workspace.focusedCon))
        throw new Error(
          `workspace ${workspaceIndex} tiled selection container ${workspace.focusedCon.id} is outside its workspace`,
        );
    }

    for (const [workspaceIndex, workspace] of this.workspaces) {
      const localFloating = new Set<WindowId>();
      for (const window of workspace.floating) {
        assertWindowId(window);
        if (localFloating.has(window))
          throw new Error(`duplicate floating window id ${window} in workspace ${workspaceIndex}`);
        localFloating.add(window);
        if (windowIds.has(window)) throw new Error(`duplicate window id ${window}`);
        windowIds.add(window);
      }
      if (workspace.focusedFloating !== null && !localFloating.has(workspace.focusedFloating))
        throw new Error(`workspace ${workspaceIndex} selected floating window is not a member`);
    }

    if (live) {
      for (const window of windowIds) {
        if (!live.has(window)) throw new Error(`tracked window ${window} is absent from the live set`);
      }
    }
  }

  private normalizeWorkspace(
    workspace: WorkspaceCon,
    live: ReadonlySet<WindowId> | undefined,
    initialFallback: Con[],
  ): void {
    let fallback = initialFallback;
    if (live) {
      const deadLeaves: LeafCon[] = [];
      for (const root of workspace.monitors.values()) collectDeadLeaves(root, live, deadLeaves);
      for (const leaf of deadLeaves) {
        if (!leaf.parent) continue;
        if (workspace.focusedCon === leaf) {
          fallback = ancestorChain(leaf.parent);
          workspace.focusedCon = null;
        }
        detach(leaf);
      }
      workspace.floating = workspace.floating.filter(window => live.has(window));
      if (workspace.focusedFloating !== null && !workspace.floating.includes(workspace.focusedFloating))
        workspace.focusedFloating = workspace.floating[0] ?? null;
    }

    let changed = true;
    while (changed) {
      changed = false;
      const splits: SplitCon[] = [];
      for (const root of workspace.monitors.values()) collectSplitsPostorder(root, splits);
      for (const con of splits) {
        if (con.root || con.parent === null || !con.parent.children.includes(con)) continue;
        if (con.children.length === 0) {
          if (workspace.focusedCon === con) {
            fallback = ancestorChain(con.parent);
            workspace.focusedCon = null;
          }
          detach(con);
          changed = true;
          continue;
        }
        const only = con.children.length === 1 ? con.children[0] : undefined;
        const flatten = splitLayouts.has(con.layout)
          && only?.kind === 'split'
          && splitLayouts.has(only.layout)
          && only.layout !== con.layout
          && only.layout === con.parent.layout;
        if (!flatten || !only) continue;
        const parent = con.parent;
        detach(only);
        replace(parent, con, only);
        if (workspace.focusedCon === con) workspace.focusedCon = only;
        changed = true;
      }
      repairWorkspace(workspace, fallback);
    }
    repairWorkspace(workspace, fallback);
  }
}

function inspectCon(
  con: Con,
  expectedParent: SplitCon | null,
  monitorRoot: boolean,
  seenCons: Set<Con>,
  nodeIds: Set<number>,
  windowIds: Set<WindowId>,
  owned: Set<Con>,
): void {
  if (seenCons.has(con)) throw new Error(`container ${con.id} forms a cycle or is a shared child`);
  seenCons.add(con);
  owned.add(con);
  if (!Number.isInteger(con.id) || con.id <= 0) throw new Error(`invalid node id ${con.id}`);
  if (nodeIds.has(con.id)) throw new Error(`duplicate node id ${con.id}`);
  nodeIds.add(con.id);
  if (con.parent !== expectedParent) throw new Error(`container ${con.id} has a bad parent link`);
  if (monitorRoot && con.kind !== 'split')
    throw new Error(`monitor root ${con.id} must be a split container`);

  if (con.kind === 'leaf') {
    if (!Number.isInteger(con.window) || con.window <= 0)
      throw new Error(`container ${con.id} has invalid window id ${String(con.window)}`);
    if (windowIds.has(con.window))
      throw new Error(`container ${con.id} has duplicate window id ${con.window}`);
    windowIds.add(con.window);
    return;
  }

  if (!layouts.has(con.layout)) throw new Error(`container ${con.id} has an invalid layout`);
  if (!splitLayouts.has(con.lastSplitLayout))
    throw new Error(`container ${con.id} has an invalid last split layout`);
  if (monitorRoot) {
    if (!con.root || con.parent !== null)
      throw new Error(`monitor root ${con.id} must be flagged and unparented`);
    if (!splitLayouts.has(con.layout))
      throw new Error(`monitor root ${con.id} has an invalid root layout`);
  } else if (con.root) {
    throw new Error(`root container ${con.id} appears under another container`);
  }

  if (con.percents.length !== con.children.length)
    throw new Error(`container ${con.id} percentage length does not match its children`);
  if (!monitorRoot && con.children.length === 0)
    throw new Error(`container ${con.id} is an empty non-root split`);
  if (con.children.length === 0) {
    if (con.focusedChild !== null)
      throw new Error(`empty container ${con.id} has an invalid focused child`);
  } else {
    if (con.focusedChild === null || !con.children.includes(con.focusedChild))
      throw new Error(`container ${con.id} has an invalid focused child`);
    for (const percent of con.percents) {
      if (!Number.isFinite(percent))
        throw new Error(`container ${con.id} percentage must be finite`);
      if (percent <= 0) throw new Error(`container ${con.id} percentage must be positive`);
    }
    const total = con.percents.reduce((sum, percent) => sum + percent, 0);
    if (Math.abs(total - 1) > 1e-9)
      throw new Error(`container ${con.id} percentage sum must equal one`);
  }

  const only = con.children.length === 1 ? con.children[0] : undefined;
  if (!con.root && con.parent !== null && splitLayouts.has(con.layout)
      && only?.kind === 'split' && splitLayouts.has(only.layout)
      && only.layout !== con.layout && only.layout === con.parent.layout)
    throw new Error(`container ${con.id} has a remaining flatten opportunity`);

  for (const child of con.children)
    inspectCon(child, con, false, seenCons, nodeIds, windowIds, owned);
}

function contains(root: Con, target: Con): boolean {
  const pending: Con[] = [root];
  const seen = new Set<Con>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    if (current === target) return true;
    seen.add(current);
    if (current.kind === 'split') pending.push(...current.children);
  }
  return false;
}

function findLeaf(root: Con, window: WindowId): LeafCon | null {
  const pending: Con[] = [root];
  const seen = new Set<Con>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    if (current.kind === 'leaf') {
      if (current.window === window) return current;
    } else {
      for (let index = current.children.length - 1; index >= 0; index--)
        pending.push(current.children[index]);
    }
  }
  return null;
}

function ancestorChain(parent: SplitCon | null): Con[] {
  const result: Con[] = [];
  const seen = new Set<Con>();
  let current: Con | null = parent;
  while (current && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = current.parent;
  }
  return result;
}

function collectDeadLeaves(con: Con, live: ReadonlySet<WindowId>, result: LeafCon[]): void {
  if (con.kind === 'leaf') {
    if (!live.has(con.window)) result.push(con);
    return;
  }
  for (const child of con.children) collectDeadLeaves(child, live, result);
}

function collectSplitsPostorder(con: Con, result: SplitCon[]): void {
  if (con.kind === 'leaf') return;
  for (const child of con.children) collectSplitsPostorder(child, result);
  result.push(con);
}

function repairWorkspace(workspace: WorkspaceCon, fallback: readonly Con[]): void {
  for (const root of workspace.monitors.values()) repairFocusedChildren(root);
  if (workspace.focusedCon === null || !workspaceContains(workspace, workspace.focusedCon)) {
    const ancestor = fallback.find(con => workspaceContains(workspace, con));
    if (ancestor) workspace.focusedCon = descendFocused(ancestor) ?? ancestor;
    else {
      const root = workspace.monitors.values().next().value as SplitCon | undefined;
      workspace.focusedCon = root ? descendFocused(root) ?? root : null;
    }
  }
  if (workspace.focusedCon) focusChain(workspace.focusedCon);
  if (workspace.focusedFloating !== null && !workspace.floating.includes(workspace.focusedFloating))
    workspace.focusedFloating = workspace.floating[0] ?? null;
}

function repairFocusedChildren(con: Con): void {
  if (con.kind === 'leaf') return;
  if (con.focusedChild === null || !con.children.includes(con.focusedChild))
    con.focusedChild = con.children[0] ?? null;
  for (const child of con.children) repairFocusedChildren(child);
}

function workspaceContains(workspace: WorkspaceCon, target: Con): boolean {
  for (const root of workspace.monitors.values()) {
    if (contains(root, target)) return true;
  }
  return false;
}

function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
}

function assertNonnegativeInteger(value: number, label: string): void {
  assertInteger(value, label);
  if (value < 0) throw new Error(`${label} must be nonnegative`);
}

function assertWindowId(window: WindowId): void {
  assertInteger(window, 'window id');
  if (window <= 0) throw new Error('window id must be positive');
}
