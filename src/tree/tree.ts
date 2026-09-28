import type {Direction, Layout} from '../commands/model';
import {descendDirection, nextFocus, type Wrapping} from './focus';
import {
  birthAssignment, coverOutputs, effectiveWorkspaceCount, orderOutputs, reassignLost, type OutputRef,
} from './outputs';
import {resizeCon, type ResizeRequest} from './resize';
import {moveCon, setLayout, splitCon, toggleLayout} from './operations';
import {
  attach,
  descendFocused,
  detach,
  focusChain,
  isForward,
  leaves,
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
  /** Which workspace each live output currently shows. Exactly one entry per live output. */
  readonly visible: Map<MonitorId, number>;
  focusedOutput: MonitorId;
  private nextNodeId = 1;
  /**
   * The live outputs in `orderOutputs`' order (primary first, then the rest by Mutter index):
   * `coverOutputs` needs them in this order to pick a donor deterministically, and `[...this.visible.keys()]`
   * is not it -- `reconfigure` deletes dead keys and re-sets survivors, and re-setting an existing `Map`
   * key leaves it where it was while a newly attached output is appended, so after a replug the key
   * order diverges from the real one. Assigned from `orderOutputs(...)` here and again in `reconfigure`.
   */
  private _ordered: readonly MonitorId[];

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

  constructor(
    requestedWorkspaceCount: number,
    outputs: readonly OutputRef[],
    primary: MonitorId,
    pinned: ReadonlyMap<number, MonitorId> = new Map(),
  ) {
    assertInteger(requestedWorkspaceCount, 'workspace count');
    // Rejected explicitly, before the clamp: only a request that is merely low, not negative, is
    // meant to be widened. Math.max would otherwise absorb a negative count silently.
    if (requestedWorkspaceCount < 0) throw new Error('workspace count must be nonnegative');
    if (outputs.length === 0) throw new Error('at least one monitor is required');
    const seen = new Set<MonitorId>();
    for (const output of outputs) {
      assertNonnegativeInteger(output.id, 'monitor id');
      if (seen.has(output.id)) throw new Error(`duplicate monitor id ${output.id}`);
      seen.add(output.id);
    }
    assertNonnegativeInteger(primary, 'primary monitor id');

    // i3 creates one workspace per output at startup whatever the config names; raising a request
    // that falls short keeps invariant 2 (every output shows one of its own) total.
    const workspaceCount = effectiveWorkspaceCount(requestedWorkspaceCount, outputs.length);
    if (workspaceCount < 1 || workspaceCount > 36)
      throw new Error('workspace count must be between 1 and 36');

    const ordered = orderOutputs(outputs, primary);
    this._ordered = ordered;
    // The clamp guarantees enough workspaces exist; it does not guarantee birthAssignment's pins
    // distributed them so every output has one — coverOutputs repairs that. Nothing is shown yet, so
    // there is no "currently displayed" workspace for it to avoid taking.
    const assignment = coverOutputs(birthAssignment(ordered, workspaceCount, pinned), ordered, new Map());
    this.workspaces = new Map();
    for (let index = 0; index < workspaceCount; index++) {
      this.workspaces.set(index, {
        index,
        output: assignment.get(index)!,
        root: this.allocateSplit('splith', true),
        focusedCon: null,
        floating: [],
        focusedFloating: null,
      });
    }
    // focusedCon starts at the workspace's own root, as it did when the first monitor's root was taken.
    for (const workspace of this.workspaces.values()) workspace.focusedCon = workspace.root;

    this.visible = new Map();
    for (const output of ordered) {
      const own = [...this.workspaces.values()].filter(w => w.output === output).map(w => w.index);
      // Invariant 2: every output shows one of its own — sound because coverOutputs guarantees every
      // output above owns at least one workspace, not merely because workspaceCount is large enough.
      this.visible.set(output, own[0]!);
    }
    this.focusedOutput = primary;
  }

  /** The output a workspace lives on. */
  outputOf(workspace: number): MonitorId {
    return this.workspace(workspace).output;
  }

  /** An output's workspaces, ascending. Each bar is drawn from this. */
  workspacesOn(output: MonitorId): number[] {
    return [...this.workspaces.values()]
      .filter(workspace => workspace.output === output)
      .map(workspace => workspace.index)
      .sort((a, b) => a - b);
  }

  /** The workspace the user is on. Derived — GNOME's active workspace is a constant now. */
  get activeWorkspace(): number {
    const workspace = this.visible.get(this.focusedOutput);
    if (workspace === undefined)
      throw new Error(`focused output ${this.focusedOutput} shows no workspace`);
    return workspace;
  }

  /**
   * The live output set, as a stable string, so the engine can tell a real monitor change from a no-op.
   * Task 5's `_layoutAndPublish` compares it against the topology's sorted ids.
   */
  outputSignature(): string {
    return [...this.visible.keys()].sort((a, b) => a - b).join(',');
  }

  /**
   * i3's `workspace N`. Two cases, and only two.
   *
   * Visible somewhere already: move the focused output to it, changing no window's workspace — this is
   * i3's "go to where that workspace is", and it is why a keypress can move you to another screen.
   * Not visible: bring it to the focused output, which is what i3 does for a workspace that does not
   * exist yet. With the fixed set of workspaces this design keeps, "not yet placed" plays that role.
   */
  showWorkspace(index: number): {output: MonitorId; swap: boolean} {
    this.workspace(index);
    for (const [output, visible] of this.visible) {
      if (visible !== index) continue;
      this.focusedOutput = output;
      return {output, swap: false};
    }
    const output = this.focusedOutput;
    this.workspace(index).output = output;
    this.visible.set(output, index);
    return {output, swap: true};
  }

  /**
   * Reassign the focused workspace to `output` and show it there. The vacated output falls back to its
   * lowest-numbered remaining workspace, or — owning none — one that `coverOutputs` takes from whichever
   * output holds the most, because invariant 2 forbids an output showing nothing.
   *
   * **Do not hand-roll donor selection here.** `coverOutputs` in `src/tree/outputs.ts` is the single place
   * that decides which output gives one up, it carries the pigeonhole argument for why a donor always
   * exists, and `reconfigure` already applies it in exactly this shape — build a `preRepair` map of
   * `index → output`, pass it through `coverOutputs`, write the result back.
   *
   * `coverOutputs` needs the outputs in order, and `[...this.visible.keys()]` is not that order (see
   * `_ordered`'s own comment) — `this._ordered` is read here instead.
   */
  moveWorkspaceToOutput(output: MonitorId): {vacated: MonitorId; nowVisible: number} | null {
    if (!this.visible.has(output)) return null;
    const index = this.activeWorkspace;
    const vacated = this.workspace(index).output;
    if (vacated === output) return null;
    this.workspace(index).output = output;
    this.visible.set(output, index);
    this.focusedOutput = output;
    // The vacated output may now own nothing; coverOutputs repairs exactly that and nothing else.
    const preRepair = new Map([...this.workspaces.values()].map(w => [w.index, w.output]));
    for (const [i, out] of coverOutputs(preRepair, this._ordered, this.visible))
      this.workspace(i).output = out;
    const own = this.workspacesOn(vacated);
    this.visible.set(vacated, own[0]!);
    return {vacated, nowVisible: own[0]!};
  }

  workspace(index: number): WorkspaceCon {
    assertNonnegativeInteger(index, 'workspace index');
    const workspace = this.workspaces.get(index);
    if (!workspace) throw new Error(`unknown workspace ${index}`);
    return workspace;
  }

  // was root(workspace, monitor)
  root(workspace: number): SplitCon {
    return this.workspace(workspace).root;
  }

  // was: for (const root of workspace.monitors.values())
  find(window: WindowId): LeafCon | null {
    assertWindowId(window);
    for (const workspace of this.workspaces.values()) {
      const found = findLeaf(workspace.root, window);
      if (found) return found;
    }
    return null;
  }

  owner(con: Con): WorkspaceCon {
    for (const workspace of this.workspaces.values())
      if (contains(workspace.root, con)) return workspace;
    throw new Error(`container ${con.id} is not owned by this tree`);
  }

  // `monitor` becomes `output`, and is never null: a floating window's output is its workspace's.
  location(window: WindowId): {workspace: number; output: MonitorId; floating: boolean} | null {
    assertWindowId(window);
    for (const [index, workspace] of this.workspaces) {
      if (findLeaf(workspace.root, window))
        return {workspace: index, output: workspace.output, floating: false};
      if (workspace.floating.includes(window))
        return {workspace: index, output: workspace.output, floating: true};
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

  reconfigure(
    requestedWorkspaceCount: number,
    outputs: readonly OutputRef[],
    primary: MonitorId,
    pinned: ReadonlyMap<number, MonitorId> = new Map(),
  ): Map<WindowId, number> {
    assertInteger(requestedWorkspaceCount, 'workspace count');
    // Rejected explicitly, before the clamp: only a request that is merely low, not negative, is
    // meant to be widened. Math.max would otherwise absorb a negative count silently.
    if (requestedWorkspaceCount < 0) throw new Error('workspace count must be nonnegative');
    if (outputs.length === 0) throw new Error('at least one monitor is required');
    const targetOutputs = new Set<MonitorId>();
    for (const output of outputs) {
      assertNonnegativeInteger(output.id, 'monitor id');
      if (targetOutputs.has(output.id)) throw new Error(`duplicate monitor id ${output.id}`);
      targetOutputs.add(output.id);
    }
    assertNonnegativeInteger(primary, 'primary monitor id');
    if (!targetOutputs.has(primary)) throw new Error(`primary monitor ${primary} is absent`);

    // i3 creates one workspace per output whatever the config names; raising a request that falls
    // short of the live output count keeps invariant 2 (every output shows one of its own) total.
    const workspaceCount = effectiveWorkspaceCount(requestedWorkspaceCount, outputs.length);
    if (workspaceCount < 1 || workspaceCount > 36)
      throw new Error('workspace count must be between 1 and 36');

    // Captured before anything below mutates this.visible, so the shrink block still knows which
    // workspace the user was actually on when this call started.
    const activeBefore = this.visible.get(this.focusedOutput);

    const live = new Set(outputs.map(output => output.id));
    const ordered = orderOutputs(outputs, primary);
    this._ordered = ordered;

    const lossAssignment = new Map<number, MonitorId>(
      [...this.workspaces].map(([index, workspace]) => [index, workspace.output]),
    );
    for (const [index, output] of reassignLost(lossAssignment, live, primary))
      this.workspace(index).output = output;

    // `pinned` is consulted only here, for the indices this loop is creating — never for a workspace
    // that already existed (those are `reassignLost`'s concern above, never a pin's). §2.3: a pin says
    // where a workspace is born, not where it stays forever; `move workspace to output` must still be
    // able to move an existing one, so re-reading the pin on every reconfigure would silently undo that.
    // If a future task adds remembered placements for a returning output (`adoptOutput`), those apply to
    // workspaces that already existed before this call and so are outside this loop too — memory is
    // about where a workspace already was, a pin is about where one that has never existed yet should
    // start, and the two do not compete here. A pin naming an output that is not live (or gone missing
    // from `outputs` since it was resolved) is ignored, exactly as at birth in the constructor.
    for (let index = this.workspaces.size; index < workspaceCount; index++) {
      const root = this.allocateSplit('splith', true);
      const pin = pinned.get(index);
      this.workspaces.set(index, {
        index,
        output: pin !== undefined && targetOutputs.has(pin) ? pin : primary,
        root,
        focusedCon: root,
        floating: [],
        focusedFloating: null,
      });
    }

    // Set only when the shrink below runs, so the rebuild after it can prefer "wherever the content
    // just merged to" over an unrelated lowest-numbered workspace when an output owns both.
    let destinationIndex: number | undefined;

    const moves = new Map<WindowId, number>();
    if (workspaceCount < this.workspaces.size) {
      const destination = this.workspace(workspaceCount - 1);
      destinationIndex = destination.index;
      let movedActiveCon: Con | null = null;
      let movedActiveFloating: WindowId | null = null;

      for (let index = workspaceCount; index < this.workspaces.size; index++) {
        const source = this.workspace(index);
        let selectedCon = source.focusedCon;
        const sourceRoot = source.root;
        for (const leaf of leaves(sourceRoot)) moves.set(leaf.window, destination.index);
        const selectedRoot = selectedCon === sourceRoot;
        const hadContents = sourceRoot.children.length > 0;
        appendRootContents(sourceRoot, destination.root, this.allocateSplit);
        if (selectedRoot) selectedCon = hadContents ? destination.root.children.at(-1)! : null;

        for (const window of source.floating) {
          moves.set(window, destination.index);
          if (!destination.floating.includes(window)) destination.floating.push(window);
        }
        if (index === activeBefore) {
          if (source.focusedFloating !== null) movedActiveFloating = source.focusedFloating;
          else movedActiveCon = selectedCon;
        }
      }

      for (let index = this.workspaces.size - 1; index >= workspaceCount; index--)
        this.workspaces.delete(index);

      if (activeBefore !== undefined && activeBefore >= workspaceCount) {
        if (movedActiveFloating !== null) {
          destination.focusedFloating = movedActiveFloating;
        } else if (movedActiveCon !== null) {
          destination.focusedCon = movedActiveCon;
          destination.focusedFloating = null;
        }
      }
      this.normalizeWorkspace(destination, undefined, []);
    }

    // Coverage repair: reassignment, growth and the shrink above only move content and existence
    // around by index, never by ownership, so any of them can still leave a live output owning
    // nothing (see coverOutputs). This runs after the shrink, not just after growth, because shrink
    // does not consult ownership either — repairing only beforehand would let it delete the very
    // workspace just given to a needy output and re-orphan it in the same call.
    const preRepair = new Map<number, MonitorId>(
      [...this.workspaces].map(([index, workspace]) => [index, workspace.output]),
    );
    for (const [index, output] of coverOutputs(preRepair, ordered, this.visible))
      this.workspace(index).output = output;

    // Rebuild visibility from scratch, now that ownership is final: an output keeps showing its
    // workspace if it still owns it; failing that, it prefers wherever the shrink above just merged
    // content to if it owns that (so the active output keeps watching what it was watching, rather
    // than jumping to an unrelated workspace merely because it is numbered lowest); failing that, it
    // takes its lowest-numbered. Roots are never merged, so no layout is lost.
    for (const output of [...this.visible.keys()]) if (!live.has(output)) this.visible.delete(output);
    for (const output of ordered) {
      const own = this.workspacesOn(output);
      const current = this.visible.get(output);
      if (current !== undefined && own.includes(current)) continue;
      this.visible.set(
        output,
        destinationIndex !== undefined && own.includes(destinationIndex) ? destinationIndex : own[0]!,
      );
    }
    if (!live.has(this.focusedOutput)) this.focusedOutput = primary;

    this.normalize();
    return moves;
  }

  addFloating(window: WindowId, workspace: number): void {
    assertWindowId(window);
    const ws = this.workspace(workspace);
    if (this.location(window)) throw new Error(`window ${window} is already tracked`);
    ws.floating.unshift(window);
    ws.focusedFloating = window;
  }

  setFloating(window: WindowId, enabled: boolean): void {
    assertWindowId(window);
    const location = this.location(window);
    if (!location) throw new Error(`window ${window} is not tracked`);
    if (location.floating === enabled) return;

    const workspace = this.workspace(location.workspace);
    if (enabled) {
      const leaf = this.find(window);
      if (!leaf) throw new Error(`tiled window ${window} has no container`);
      const fallback = workspace.focusedCon === leaf ? ancestorChain(leaf.parent) : [];
      if (workspace.focusedCon === leaf) workspace.focusedCon = null;
      detach(leaf);
      this.normalizeWorkspace(workspace, undefined, fallback);
      workspace.floating.unshift(window);
      workspace.focusedFloating = window;
      return;
    }

    const index = workspace.floating.indexOf(window);
    if (index === -1) throw new Error(`floating window ${window} is not owned by its workspace`);
    workspace.floating.splice(index, 1);
    if (workspace.focusedFloating === window)
      workspace.focusedFloating = workspace.floating[0] ?? null;
    this.insert(window, location.workspace);
  }

  focusModeToggle(): WindowId | null {
    const selection = this.selection();
    if (!selection) return null;
    if (selection.kind === 'tiled') {
      const workspace = this.owner(selection.con);
      const target = workspace.floating[0];
      if (target === undefined) return null;
      this.selectFloating(target);
      return target;
    }

    const location = this.location(selection.window);
    if (!location) throw new Error(`floating window ${selection.window} is not tracked`);
    const workspace = this.workspace(location.workspace);
    const tiled = workspace.focusedCon ? descendFocused(workspace.focusedCon) : null;
    if (!tiled) return null;
    this.select(tiled);
    return tiled.window;
  }

  // The target workspace's root is the only candidate now — it has exactly one.
  moveToWorkspace(target: number): WindowId[] {
    const targetWorkspace = this.workspace(target);
    const targetRoot = targetWorkspace.root;
    const selection = this.selection();
    if (!selection) return [];

    if (selection.kind === 'floating') {
      const location = this.location(selection.window);
      if (!location) throw new Error(`floating window ${selection.window} is not tracked`);
      if (location.workspace === target) return [];
      const sourceWorkspace = this.workspace(location.workspace);
      const index = sourceWorkspace.floating.indexOf(selection.window);
      if (index === -1)
        throw new Error(`floating window ${selection.window} is not owned by its workspace`);
      sourceWorkspace.floating.splice(index, 1);
      sourceWorkspace.focusedFloating = sourceWorkspace.floating[0] ?? null;
      targetWorkspace.floating = [
        selection.window,
        ...targetWorkspace.floating.filter(window => window !== selection.window),
      ];
      targetWorkspace.focusedFloating = selection.window;
      return [selection.window];
    }

    const sourceWorkspace = this.owner(selection.con);
    if (sourceWorkspace === targetWorkspace) return [];
    const windows = [...leaves(selection.con)].map(leaf => leaf.window);
    if (windows.length === 0) return [];

    let moved: Con;
    let fallback: Con[];
    if (selection.con.kind === 'split' && selection.con.root) {
      const sourceRoot = selection.con;
      const wrapper = this.allocateSplit(sourceRoot.layout);
      wrapper.lastSplitLayout = sourceRoot.lastSplitLayout;
      wrapper.children = sourceRoot.children;
      wrapper.percents = sourceRoot.percents;
      wrapper.focusedChild = sourceRoot.focusedChild;
      for (const child of wrapper.children) child.parent = wrapper;
      sourceRoot.children = [];
      sourceRoot.percents = [];
      sourceRoot.focusedChild = null;
      moved = wrapper;
      fallback = [sourceRoot];
    } else {
      fallback = ancestorChain(selection.con.parent);
      sourceWorkspace.focusedCon = null;
      detach(selection.con);
      moved = selection.con;
    }

    this.normalizeWorkspace(sourceWorkspace, undefined, fallback);
    const insertion = this.insertionPoint(targetWorkspace, targetRoot);
    attach(insertion.parent, moved, insertion.index);
    this.select(moved);
    this.normalizeWorkspace(targetWorkspace, undefined, ancestorChain(moved.parent));
    return windows;
  }

  /**
   * Enter an output's visible workspace from the edge nearest the output being left: moving `right`
   * enters at its left. Returns the leaf focused, or null when that workspace is empty — in which case
   * its root is selected, because focus is output-level and an empty output is still focusable.
   */
  enterOutput(output: MonitorId, direction: Direction): LeafCon | null {
    const index = this.visible.get(output);
    if (index === undefined) return null;
    this.focusedOutput = output;
    const root = this.workspace(index).root;
    const target = descendDirection(root, direction);
    if (!target) {
      this.select(root);
      return null;
    }
    this.select(target);
    return target;
  }

  /**
   * Move the selection into an output's visible workspace. `direction` null means the workspace's normal
   * insertion point (a named or `primary` target); a direction means the entering edge.
   */
  moveIntoOutput(output: MonitorId, direction: Direction | null): WindowId[] {
    const index = this.visible.get(output);
    if (index === undefined) return [];
    if (index === this.activeWorkspace) return [];
    // moveToWorkspace already preserves a moved subtree's structure, layout, percentages and focused
    // child, including the root-contents case, so the cross-output move is that plus an edge choice.
    const moved = this.moveToWorkspace(index);
    if (moved.length > 0 && direction !== null) this._reseatAtEdge(index, direction);
    if (moved.length > 0) this.focusedOutput = output;
    return moved;
  }

  insert(window: WindowId, workspace: number): LeafCon {
    assertWindowId(window);
    const ws = this.workspace(workspace);
    if (this.location(window)) throw new Error(`window ${window} is already tracked`);

    const insertion = this.insertionPoint(ws, ws.root);
    const leaf: LeafCon = {
      kind: 'leaf',
      id: this.nextNodeId++,
      parent: null,
      window,
    };
    attach(insertion.parent, leaf, insertion.index);
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

      const leaf = findLeaf(workspace.root, window);
      if (!leaf) continue;
      const fallback = workspace.focusedCon === leaf ? ancestorChain(leaf.parent) : [];
      if (workspace.focusedCon === leaf) workspace.focusedCon = null;
      detach(leaf);
      this.normalizeWorkspace(workspace, undefined, fallback);
      return;
    }
  }

  normalize(live?: ReadonlySet<WindowId>): void {
    for (const workspace of this.workspaces.values())
      this.normalizeWorkspace(workspace, live, []);
  }

  check(live?: ReadonlySet<WindowId>): void {
    // this.activeWorkspace itself throws if focusedOutput has no visible entry, so that case never
    // reaches the "does not exist" check below.
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
      assertNonnegativeInteger(workspace.output, 'monitor id');
      const owned = new Set<Con>();
      inspectCon(workspace.root, null, true, seenCons, nodeIds, windowIds, owned);

      if (workspace.focusedCon !== null && !owned.has(workspace.focusedCon))
        throw new Error(
          `workspace ${workspaceIndex} tiled selection container ${workspace.focusedCon.id} is outside its workspace`,
        );
    }

    // Invariant 2: every output shows a workspace it owns. The constructor and reconfigure both run
    // coverOutputs so every live output owns at least one — no output should ever have to share — so
    // a violation here is a real bug, not a degraded-but-acceptable state, and must throw.
    for (const [output, shown] of this.visible) {
      const workspace = this.workspaces.get(shown);
      if (!workspace) throw new Error(`output ${output} shows unknown workspace ${shown}`);
      if (workspace.output !== output)
        throw new Error(
          `output ${output} shows workspace ${shown}, which belongs to output ${workspace.output}`,
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
      collectDeadLeaves(workspace.root, live, deadLeaves);
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
      collectSplitsPostorder(workspace.root, splits);
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

  private insertionPoint(
    workspace: WorkspaceCon,
    root: SplitCon,
  ): {parent: SplitCon; index: number} {
    const selected = workspace.focusedCon && contains(root, workspace.focusedCon)
      ? workspace.focusedCon
      : descendFocused(root) ?? root;
    const parent = selected.kind === 'leaf' ? selected.parent : selected;
    if (!parent) throw new Error(`selected container ${selected.id} has no insertion parent`);
    return {
      parent,
      index: selected.kind === 'leaf'
        ? parent.children.indexOf(selected) + 1
        : parent.children.length,
    };
  }

  /**
   * Moves the child `moveToWorkspace` just attached (`workspace.focusedCon`, which `moveToWorkspace`
   * has already set) directly to the front of the target root's children for a forward direction, or
   * the back for a backward one — the entering edge.
   *
   * Lifts the moved child *out* of whatever pre-existing nested split `insertionPoint` happened to
   * attach it inside, rather than relocating that split (and every unrelated child it already held) to
   * the edge. There is no ancestor walk here on purpose: climbing to "the nearest ancestor that is a
   * direct child of root" would grab a split that was already there before this move and drag its own
   * other children along with it, and would still leave the moved window nested inside a multi-child
   * split rather than standing alone at the edge, which is exactly what this method promises.
   *
   * Reuses `detach`/`attach` (the same pair `moveCon` uses to relocate a child across a non-adjacent
   * split) rather than splicing `percents` by hand a second time: detaching renormalizes what remains,
   * and attaching at the edge index redistributes evenly over the same count, exactly as if the child
   * had been inserted there to begin with. The follow-up `normalizeWorkspace`, seeded with the old
   * parent's own ancestor chain, is what lets a split left holding too few -- or a flattenable one --
   * children collapse, the same as any other mutation in this file.
   */
  private _reseatAtEdge(workspaceIndex: number, direction: Direction): void {
    const workspace = this.workspace(workspaceIndex);
    const root = workspace.root;
    const moved = workspace.focusedCon;
    if (!moved || !moved.parent) return;
    const to = isForward(direction) ? 0 : root.children.length - 1;
    // Parentage first, deliberately: once the child is lifted out of a nested split it is nowhere in
    // `root.children`, so `indexOf` would return -1 -- checking `moved.parent === root` first, with
    // `&&` short-circuiting, keeps that -1 from ever being compared against `to`.
    if (moved.parent === root && root.children.indexOf(moved) === to) return;
    const oldParent = moved.parent;
    detach(moved);
    attach(root, moved, isForward(direction) ? 0 : root.children.length);
    this.select(moved);
    this.normalizeWorkspace(workspace, undefined, ancestorChain(oldParent));
  }
}

function appendRootContents(source: SplitCon, target: SplitCon, allocate: AllocateSplit): void {
  if (source.children.length === 0) return;
  const wrapper = allocate(source.layout);
  wrapper.lastSplitLayout = source.lastSplitLayout;
  wrapper.children = source.children;
  wrapper.percents = source.percents;
  wrapper.focusedChild = source.focusedChild;
  for (const child of wrapper.children) child.parent = wrapper;
  source.children = [];
  source.percents = [];
  source.focusedChild = null;
  attach(target, wrapper, target.children.length);
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
  repairFocusedChildren(workspace.root);
  if (workspace.focusedCon === null || !workspaceContains(workspace, workspace.focusedCon)) {
    const ancestor = fallback.find(con => workspaceContains(workspace, con));
    workspace.focusedCon = ancestor
      ? descendFocused(ancestor) ?? ancestor
      : descendFocused(workspace.root) ?? workspace.root;
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
  return contains(workspace.root, target);
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
