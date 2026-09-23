import {describe, expect, it} from 'vitest';
import {decorationPlan} from '../../../src/runtime/decoration';
import type {Con, Rect} from '../../../src/tree/node';
import type {WindowInfo} from '../../../src/runtime/model';
import {leaf, split} from '../tree/helpers';

function R(x: number, y: number, width: number, height: number): Rect {
  return {x, y, width, height};
}

function info(id: number, patch: Partial<WindowInfo> = {}): WindowInfo {
  return {id, workspace: 0, monitor: 1, kind: 'tiled',
    rect: {x: 0, y: 0, width: 10, height: 10}, title: `Window ${id}`, wmClass: 'fixture',
    minimized: false, fullscreen: false, maximizedH: false, maximizedV: false,
    sticky: false, skipTaskbar: false, ...patch};
}

describe('decorationPlan', () => {
  it('marks the focused leaf focused and its siblings focused_inactive', () => {
    const root = split('splith', [leaf(1), leaf(2)]);
    const [a, b] = root.children;
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [a, R(0, 0, 200, 300)], [b, R(200, 0, 200, 300)]]),
      windows: new Map([[1, info(1)], [2, info(2)]]),
      focused: a, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.borders.find(x => x.window === 1)!.state).toBe('focused');
    expect(plan.borders.find(x => x.window === 2)!.state).toBe('focused_inactive');
  });

  it('marks leaves on an inactive workspace unfocused', () => {
    const root = split('splith', [leaf(1)]);
    const [a] = root.children;
    const plan = decorationPlan({
      roots: [{root, active: false}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [a, R(0, 0, 400, 300)]]),
      windows: new Map([[1, info(1)]]),
      focused: null, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.borders[0].state).toBe('unfocused');
  });

  it('produces a frame only when the selection is a container', () => {
    const root = split('splith', [leaf(1), leaf(2)]);
    const rects = new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
      [root.children[0], R(0, 0, 200, 300)], [root.children[1], R(200, 0, 200, 300)]]);
    const base = {roots: [{root, active: true}], rects,
      windows: new Map([[1, info(1)], [2, info(2)]]), rowHeight: 20, borderWidth: 2,
      borderOverrides: new Map()};
    expect(decorationPlan({...base, focused: root.children[0]}).frames).toEqual([]);
    expect(decorationPlan({...base, focused: root}).frames)
      .toEqual([{nodeId: root.id, rect: R(0, 0, 400, 300)}]);
  });

  it('describes a tabbed container as one row with the selected child marked', () => {
    const root = split('tabbed', [leaf(1), leaf(2)]);
    root.focusedChild = root.children[1];
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
        [root.children[0], R(0, 20, 400, 280)], [root.children[1], R(0, 20, 400, 280)]]),
      windows: new Map([[1, info(1)], [2, info(2, {title: 'Second'})]]),
      focused: root.children[1], rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.titleRows).toEqual([{
      nodeId: root.id, rect: R(0, 0, 400, 300), rowHeight: 20, layout: 'tabbed',
      tabs: [{nodeId: root.children[0].id, window: 1, title: 'Window 1', selected: false},
             {nodeId: root.children[1].id, window: 2, title: 'Second', selected: true}],
    }]);
  });

  it('leaves an unrelated sibling of a selected container unfocused', () => {
    // Reproduces the container-selection ($mod+a) case: A is a sibling of the
    // selected container B, not a descendant of it, so it must not inherit
    // focused_inactive from the (unrelated) `parent === parent` check.
    const a = leaf(1);
    const c = leaf(2);
    const d = leaf(3);
    const b = split('splitv', [c, d]);
    const root = split('splith', [a, b]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([
        [root, R(0, 0, 400, 300)],
        [a, R(0, 0, 200, 300)],
        [b, R(200, 0, 200, 300)],
        [c, R(200, 0, 200, 150)],
        [d, R(200, 150, 200, 150)],
      ]),
      windows: new Map([[1, info(1)], [2, info(2)], [3, info(3)]]),
      focused: b, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.borders.find(x => x.window === 1)!.state).toBe('unfocused');
    expect(plan.borders.find(x => x.window === 2)!.state).toBe('focused_inactive');
    expect(plan.borders.find(x => x.window === 3)!.state).toBe('focused_inactive');
  });

  it('titles a nested-container tab by its focused descendant and tracks its own selection', () => {
    const nested = split('splitv', [leaf(2), leaf(3)]);
    nested.focusedChild = nested.children[1];
    const root = split('tabbed', [leaf(1), nested]);
    root.focusedChild = nested;
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)]]),
      windows: new Map([
        [1, info(1)],
        [2, info(2, {title: 'Second'})],
        [3, info(3, {title: 'Third'})],
      ]),
      focused: nested, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.titleRows).toEqual([{
      nodeId: root.id, rect: R(0, 0, 400, 300), rowHeight: 20, layout: 'tabbed',
      tabs: [
        {nodeId: root.children[0].id, window: 1, title: 'Window 1', selected: false},
        {nodeId: nested.id, window: null, title: 'Third', selected: true},
      ],
    }]);
  });

  it('gives a fullscreen leaf neither a border nor a title row', () => {
    const root = split('tabbed', [leaf(1)]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [root.children[0], R(0, 20, 400, 280)]]),
      windows: new Map([[1, info(1, {fullscreen: true})]]),
      focused: root.children[0], rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.borders).toEqual([]);
    expect(plan.titleRows).toEqual([]);
  });

  it('gives a monitor root holding a fullscreen leaf no decorations at all', () => {
    // A fullscreen window owns the monitor, so every decoration on that
    // monitor would be drawn over it -- not just the row of the container
    // that holds it. Frames and title rows are added to window_group with no
    // stacking control at all (src/shell/decorations.ts), which puts them
    // above every window actor including a fullscreen one, so a tab bar on a
    // *sibling* container would paint straight over the fullscreen client.
    const tabbed = split('tabbed', [leaf(1), leaf(2)]);
    const root = split('splith', [tabbed, leaf(3)], true);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [tabbed, R(0, 0, 200, 300)],
        [tabbed.children[0], R(0, 20, 200, 280)], [tabbed.children[1], R(0, 20, 200, 280)],
        [root.children[1], R(200, 0, 200, 300)]]),
      windows: new Map([[1, info(1)], [2, info(2)], [3, info(3, {fullscreen: true})]]),
      // Focused on the tabbed container, so a frame would be produced too.
      focused: tabbed, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan).toEqual({borders: [], frames: [], titleRows: []});
  });

  it('suppresses the monitor for a fullscreen leaf nested two levels down', () => {
    // The container holding the fullscreen leaf is nowhere near the root, and
    // nowhere near the tabbed container whose row would be drawn over it.
    const inner = split('splitv', [leaf(3)]);
    const middle = split('splith', [inner]);
    const tabbed = split('tabbed', [leaf(1), leaf(2)]);
    const root = split('splith', [tabbed, middle], true);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [tabbed, R(0, 0, 200, 300)],
        [tabbed.children[0], R(0, 20, 200, 280)], [tabbed.children[1], R(0, 20, 200, 280)],
        [middle, R(200, 0, 200, 300)], [inner, R(200, 0, 200, 300)],
        [inner.children[0], R(200, 0, 200, 300)]]),
      windows: new Map([[1, info(1)], [2, info(2)], [3, info(3, {fullscreen: true})]]),
      focused: null, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan).toEqual({borders: [], frames: [], titleRows: []});
  });

  it('suppresses only the root that holds the fullscreen leaf, never the other monitors', () => {
    // The opposite failure, and the one a suite that only looks at the
    // fullscreen monitor cannot see: a fullscreen video on the laptop panel
    // must not strip the borders off the external display.
    const fullscreenRoot = split('splith', [leaf(1)], true);
    const otherTabbed = split('tabbed', [leaf(2), leaf(3)]);
    const otherRoot = split('splith', [otherTabbed], true);
    const plan = decorationPlan({
      roots: [{root: fullscreenRoot, active: true}, {root: otherRoot, active: false}],
      rects: new Map<Con, Rect>([
        [fullscreenRoot, R(0, 0, 400, 300)], [fullscreenRoot.children[0], R(0, 0, 400, 300)],
        [otherRoot, R(400, 0, 400, 300)], [otherTabbed, R(400, 0, 400, 300)],
        [otherTabbed.children[0], R(400, 20, 400, 280)],
        [otherTabbed.children[1], R(400, 20, 400, 280)]]),
      windows: new Map([[1, info(1, {fullscreen: true})], [2, info(2)], [3, info(3)]]),
      focused: otherTabbed, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.borders.map(entry => entry.window)).toEqual([2, 3]);
    expect(plan.titleRows.map(entry => entry.nodeId)).toEqual([otherTabbed.id]);
    expect(plan.frames.map(entry => entry.nodeId)).toEqual([otherTabbed.id]);
  });

  it('draws no title row over a fullscreen child, and no border on its siblings either', () => {
    // Spec 3.2 asks for this container to contribute no title row. The rule
    // that delivers it is the root one above -- the fullscreen window owns
    // the monitor, so its siblings' borders would be painted across it too
    // (their windows are behind it, their borders are not). Suppressing the
    // row alone would leave exactly that.
    const root = split('tabbed', [leaf(1), leaf(2)]);
    const [a, b] = root.children;
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
        [a, R(0, 20, 400, 280)], [b, R(0, 20, 400, 280)]]),
      windows: new Map([[1, info(1, {fullscreen: true})], [2, info(2)]]),
      focused: a, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan).toEqual({borders: [], frames: [], titleRows: []});
  });

  it('gives a row exactly one tab per child, so the engine reserves what the shell draws', () => {
    // The engine reserves rowHeight x children.length for a stacked container
    // (layoutWithRects) while the renderer divides the band by the number of
    // tabs it was given. The two agree only while every child has a tab, so
    // that is the invariant, not an incidental property: a row that omits a
    // tab under-fills a band the engine already reserved.
    const nested = split('splitv', [leaf(3)]);
    const root = split('stacked', [leaf(1), leaf(2), nested]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
        [root.children[0], R(0, 60, 400, 240)], [root.children[1], R(0, 60, 400, 240)],
        [nested, R(0, 60, 400, 240)], [nested.children[0], R(0, 60, 400, 240)]]),
      windows: new Map([[1, info(1)], [2, info(2)], [3, info(3)]]),
      // A minimized child still gets a tab: i3 has no minimized state, and a
      // tab the engine reserved a row for must be drawn in it.
      focused: null, rowHeight: 20, borderWidth: 2, borderOverrides: new Map(),
    });
    expect(plan.titleRows).toHaveLength(1);
    expect(plan.titleRows[0].tabs).toHaveLength(root.children.length);
  });

  it('prefers a per-window border override to the configured default', () => {
    // Acceptance A19: the `border` command changes one window's width.
    const root = split('splith', [leaf(1), leaf(2)]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)],
        [root.children[0], R(0, 0, 200, 300)], [root.children[1], R(200, 0, 200, 300)]]),
      windows: new Map([[1, info(1)], [2, info(2)]]),
      focused: null, rowHeight: 20, borderWidth: 2,
      borderOverrides: new Map([[1, 0]]),
    });
    expect(plan.borders.find(x => x.window === 1)!.width).toBe(0);
    expect(plan.borders.find(x => x.window === 2)!.width).toBe(2);
  });

  it('carries the configured border width on every border', () => {
    const root = split('splith', [leaf(1)]);
    const plan = decorationPlan({
      roots: [{root, active: true}],
      rects: new Map<Con, Rect>([[root, R(0, 0, 400, 300)], [root.children[0], R(0, 0, 400, 300)]]),
      windows: new Map([[1, info(1)]]),
      focused: null, rowHeight: 20, borderWidth: 5, borderOverrides: new Map(),
    });
    expect(plan.borders[0].width).toBe(5);
  });
});
