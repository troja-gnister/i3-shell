import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DecorationPlan} from '../../../src/runtime/decoration';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {WindowId} from '../../../src/tree/node';
import {log} from '../../../src/shell/log';
// Type-only: `StyledActor` is the half of the fake hierarchy that carries `label`
// and `useMarkup`. The classes themselves come in through the dynamic import below,
// so they resolve through the same mocked module `gi://St` does; this import
// contributes no runtime code.
import type {StyledActor} from './fakes/actors';

vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
// guard() (src/shell/util/signals.ts) logs through this when a tab's focus callback throws.
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {FakeActor, criticals, resetFakeActors, lastCreated, liveActors, disposedAccesses, created} =
  await import('./fakes/actors');

type Actor = InstanceType<typeof FakeActor>;

const windowGroup = new FakeActor('window_group');

(globalThis as unknown as {global: {window_group: Actor}}).global = {
  window_group: windowGroup,
};

interface FakeMetaWindow {
  get_compositor_private(): Actor | null;
}

// resolvable is what the resolve callback (Decorations' 3rd constructor arg) can find;
// a WindowId missing from it stands for one WindowTracker no longer knows about, or
// whose compositor actor doesn't exist yet -- see src/shell/windows.ts's identical
// get_compositor_private() null case.
const resolvable = new Map<WindowId, FakeMetaWindow>();
// Every id the resolver was actually asked about, in order: a stand-in for the
// production defect this suite exists to catch (WindowId and Meta.Window.get_id()
// are different id spaces; only the resolver bridges them -- see the Task 4 report).
const resolveCalls: WindowId[] = [];

function resolve(id: WindowId): FakeMetaWindow | undefined {
  resolveCalls.push(id);
  return resolvable.get(id);
}

function fakeWindow(actor: Actor | null = new FakeActor('meta-window-actor')): FakeMetaWindow {
  return {get_compositor_private: () => actor};
}

// The 4th constructor arg. In production this is the extension's deferred port (a
// GLib idle); here it queues, so a test can decide when the next main-loop turn
// happens and assert what has and has not run yet.
const deferred: Array<() => void> = [];
const defer = (fn: () => void): void => { deferred.push(fn); };
const runDeferred = (): void => { for (const fn of deferred.splice(0)) fn(); };

const {Decorations} = await vi.importActual<{
  Decorations: new (
    colors: Colors,
    focus: (window: WindowId) => void,
    resolve: (id: WindowId) => FakeMetaWindow | undefined,
    defer: (fn: () => void) => void,
  ) => {apply(plan: DecorationPlan): void; setColors(colors: Colors): void; destroy(): void};
}>('../../../src/shell/decorations');

const R = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const empty: DecorationPlan = {borders: [], frames: [], titleRows: []};
const border = (window: WindowId, rect = R(0, 0, 100, 100)): DecorationPlan =>
  ({borders: [{window, rect, state: 'focused' as const, width: 2}], frames: [], titleRows: []});
/**
 * The plan's `rowHeight` is the height of ONE title row, whatever the layout
 * (src/runtime/decoration.ts passes DecorationInput.rowHeight straight
 * through). The snapshot's same-named field is a different number -- there it
 * is already multiplied by the child count for a stacked container
 * (src/runtime/snapshot.ts) -- so a test that reads one must not reason from
 * the other.
 */
const ROW_HEIGHT = 20;
const row = (
  rect: ReturnType<typeof R>,
  tabs: DecorationPlan['titleRows'][number]['tabs'],
  layout: 'tabbed' | 'stacked' = 'tabbed',
  rowHeight: number = ROW_HEIGHT,
): DecorationPlan =>
  ({borders: [], frames: [], titleRows: [{nodeId: 7, rect, rowHeight, layout, tabs}]});
const tab = (nodeId: number, title: string, window: WindowId | null = null) =>
  ({nodeId, window, title, selected: false});

/** Every tab button built so far, in creation order. */
const tabActors = (): StyledActor[] =>
  created.filter(actor => actor.props.style_class === 'i3-shell-tab') as StyledActor[];

beforeEach(() => {
  resolvable.clear();
  resolveCalls.length = 0;
  deferred.length = 0;
  resetFakeActors();
  windowGroup.children.length = 0;
  vi.mocked(log.error).mockClear();
});

describe('Decorations', () => {
  it('reuses a border actor when only its rectangle changed', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(border(1, R(0, 0, 100, 100)));
    const first = lastCreated('border');
    d.apply(border(1, R(50, 0, 100, 100)));
    expect(lastCreated('border')).toBe(first);
    expect(first.destroyed).toBe(false);
    expect(first.geometry).toEqual(R(50, 0, 100, 100));
  });

  it('destroys actors the plan no longer contains', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(border(1));
    const actor = lastCreated('border');
    d.apply(empty);
    expect(actor.destroyCount).toBe(1);
    expect(actor.destroyed).toBe(true);
  });

  it('keys title rows by nodeId, not by rectangle', () => {
    resolvable.set(1, fakeWindow());
    const tabs = [{nodeId: 1, window: 1 as WindowId, title: 'One', selected: true}];
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(0, 0, 400, 300), tabs));
    const first = lastCreated('row');
    d.apply(row(R(0, 0, 200, 300), tabs));
    // A rectangle key would have destroyed and rebuilt an actor that only moved.
    expect(lastCreated('row')).toBe(first);
    expect(first.destroyCount).toBe(0);
    // The box follows the container's x/y and width, but never its height --
    // it is the reserved band, not the container (see the geometry tests).
    expect(first.geometry).toEqual(R(0, 0, 200, ROW_HEIGHT));
  });

  it('skips a window when the resolver finds nothing, without touching a disposed actor', () => {
    // Review Focus: the plan names a WindowId; by render time the window may
    // be gone (resolve() misses) or its compositor actor may not exist yet
    // (get_compositor_private() returns null) -- either way, skip silently.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    expect(() => d.apply(border(99))).not.toThrow();
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors().filter(actor => actor.props.style_class === 'i3-shell-border')).toEqual([]);
  });

  it('consults the resolver with the exact WindowId the plan names', () => {
    // Review Focus: WindowId is a synthetic id WindowTracker assigns, unrelated
    // to Meta.Window.get_id() -- the resolver is the only bridge between the
    // two id spaces, so a future change that resolves anything else (e.g.
    // scanning global.get_window_actors() by Meta id) must fail loudly here,
    // not just render nothing silently in production.
    resolvable.set(42, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(border(42));
    expect(resolveCalls).toEqual([42]);
  });

  it('skips a window whose window actor is null, e.g. before its first frame', () => {
    // get_compositor_private() returns null until Mutter has an actor for the
    // window; @girs types it non-nullable (see src/shell/windows.ts's cast).
    resolvable.set(1, fakeWindow(null));
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    expect(() => d.apply(border(1))).not.toThrow();
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors().filter(actor => actor.props.style_class === 'i3-shell-border')).toEqual([]);
  });

  it('stacks each border immediately above its own window actor in window_group', () => {
    // Was "immediately below" (the plan's original wording), which drew every
    // border underneath an opaque window and so drew nothing at all. The
    // border actor paints only its outline -- no background -- so above the
    // window it is the one thing visible and the client shows through the
    // middle. Two windows, so the assertion distinguishes "above its own
    // window" from "somewhere near the top".
    const first = new FakeActor('meta-window-actor');
    const second = new FakeActor('meta-window-actor');
    windowGroup.add_child(first);          // where Mutter keeps the real window actors
    windowGroup.add_child(second);
    resolvable.set(1, fakeWindow(first));
    resolvable.set(2, fakeWindow(second));
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply({
      borders: [
        {window: 1, rect: R(0, 0, 100, 100), state: 'focused', width: 2},
        {window: 2, rect: R(0, 0, 100, 100), state: 'unfocused', width: 2},
      ],
      frames: [], titleRows: [],
    });
    const borders = created.filter(actor => actor.props.style_class === 'i3-shell-border');
    expect(borders).toHaveLength(2);
    expect(windowGroup.children).toHaveLength(4);
    expect(windowGroup.children[0]).toBe(first);
    expect(windowGroup.children[1]).toBe(borders[0]);
    expect(windowGroup.children[2]).toBe(second);
    expect(windowGroup.children[3]).toBe(borders[1]);
  });

  it('keeps a border non-reactive, so a border above a window cannot swallow its input', () => {
    // Load-bearing since the border moved above the window actor: a reactive
    // actor covering the client would eat every click on it.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(border(1));
    expect(lastCreated('border').props.reactive).toBe(false);
  });

  it('does not interpret markup in a tab title', () => {
    // Review Focus: titles come from arbitrary applications.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: '<b>x</b>', selected: true}]));
    const tab = tabActors()[0];
    expect(tab.label).toBe('<b>x</b>');
    expect(tab.useMarkup).toBe(false);
  });

  it('focuses the tab that was clicked, without touching the tree', () => {
    resolvable.set(1, fakeWindow());
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w), resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: 'One', selected: false}]));
    lastCreated('tab').emit('clicked');
    runDeferred();
    expect(focused).toEqual([1]);
  });

  it('defers a tab click by one main-loop turn', () => {
    // Review Focus: _focus drives an engine focus command, which commits
    // synchronously and calls apply() -- and that apply() can destroy this very
    // button in the tab sweep. Running it inside St's `clicked` emission would
    // unwind the stack back into a disposed St.Button.
    resolvable.set(1, fakeWindow());
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w), resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: 'One', selected: false}]));
    lastCreated('tab').emit('clicked');
    expect(focused).toEqual([]);         // nothing yet: the emission has not returned
    expect(deferred).toHaveLength(1);
    runDeferred();
    expect(focused).toEqual([1]);
  });

  it('drops a deferred tab click when Decorations was destroyed in the meantime', () => {
    // disable() can land between the click and the idle that carries it.
    resolvable.set(1, fakeWindow());
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w), resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: 'One', selected: false}]));
    lastCreated('tab').emit('clicked');
    d.destroy();
    runDeferred();
    expect(focused).toEqual([]);
    expect(criticals).toEqual([]);
  });

  it('logs rather than throws when the focus callback fails', () => {
    // guard() (src/shell/util/signals.ts) keeps an exception out of the Shell's
    // signal handler and out of the main loop, exactly as indicator.ts does for
    // its pill click.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => { throw new Error('boom'); }, resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: 'One', selected: false}]));
    expect(() => lastCreated('tab').emit('clicked')).not.toThrow();
    expect(() => runDeferred()).not.toThrow();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });

  it('does not focus anything for a nested-container tab, whose window is null', () => {
    // Review Focus: a tab's window is WindowId | null; a nested-container tab has null.
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w), resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: null, title: 'Nested', selected: false}]));
    expect(() => lastCreated('tab').emit('clicked')).not.toThrow();
    runDeferred();
    expect(focused).toEqual([]);
  });

  it('destroys every actor on destroy(), and touches none afterwards', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply({...border(1), frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}]});
    d.destroy();
    d.destroy();                       // idempotent, as disable() is
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors()).toEqual([]);
  });

  it('destroys a title row through the box -> button cascade on destroy()', () => {
    // The destroy() comment leans on Clutter tearing the subtree down with the
    // parent; the plan in the test above has no rows, so nothing exercised it.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [
      {nodeId: 1, window: 1, title: 'One', selected: true},
      {nodeId: 2, window: null, title: 'Nested', selected: false},
    ]));
    const box = lastCreated('row');
    const buttons = tabActors();
    expect(buttons).toHaveLength(2);
    d.destroy();
    d.destroy();
    expect(box.destroyCount).toBe(1);
    expect(buttons.map(button => button.destroyCount)).toEqual([1, 1]);
    expect(liveActors()).toEqual([]);
    expect(criticals).toEqual([]);
  });

  it('destroys a row the plan no longer contains, with its tab buttons', () => {
    // Only row *persistence* was covered; the _rows sweep itself was not.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    const tabs = [{nodeId: 1, window: 1 as WindowId, title: 'One', selected: true}];
    d.apply(row(R(0, 0, 400, 300), tabs));
    const box = lastCreated('row');
    const [button] = tabActors();
    d.apply(empty);
    expect(box.destroyCount).toBe(1);
    expect(button.destroyed).toBe(true);
    expect(criticals).toEqual([]);
    // Really gone, not merely destroyed: the next plan must build a new row
    // rather than write through a map entry that outlived its actor.
    d.apply(row(R(0, 0, 400, 300), tabs));
    expect(lastCreated('row')).not.toBe(box);
    expect(criticals).toEqual([]);
  });

  it('destroys a tab the plan dropped from a row that survives', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    const two = [
      {nodeId: 1, window: 1 as WindowId, title: 'One', selected: true},
      {nodeId: 2, window: null, title: 'Two', selected: false},
    ];
    d.apply(row(R(0, 0, 400, 300), two));
    const box = lastCreated('row');
    const [first, second] = tabActors();
    d.apply(row(R(0, 0, 400, 300), [two[0]]));
    expect(second.destroyCount).toBe(1);
    expect(first.destroyed).toBe(false);
    expect(box.destroyed).toBe(false);
    expect(criticals).toEqual([]);
    // The dropped tab comes back as a new button, not through a stale entry.
    d.apply(row(R(0, 0, 400, 300), two));
    expect(tabActors()).toHaveLength(3);
    expect(criticals).toEqual([]);
  });

  it('rebuilds a border whose actor was destroyed behind its back, without writing to it', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(border(1));
    const actor = lastCreated('border');
    // Anything outside this class can dispose the actor -- GNOME does exactly
    // that to window_group's children at shutdown, before disable() runs.
    actor.destroy();
    // Positive control, and the only one in the whole shell suite: every other
    // `criticals` assertion here is `toEqual([])`, so a recorder that silently
    // stopped recording would leave all of them green. Prove it still records
    // before the assertion below leans on it.
    actor.set_position(1, 1);
    expect(criticals).toEqual(['St.Widget.set_position after dispose']);
    criticals.length = 0;

    d.apply(border(1, R(5, 5, 50, 50)));
    expect(criticals).toEqual([]);
    const rebuilt = lastCreated('border');
    expect(rebuilt).not.toBe(actor);
    expect(rebuilt.geometry).toEqual(R(5, 5, 50, 50));
  });

  it('does not destroy an actor twice after it was destroyed behind its back', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply({
      borders: [{window: 1, rect: R(0, 0, 100, 100), state: 'focused', width: 2}],
      frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}],
      titleRows: [{
        nodeId: 7, rect: R(0, 0, 400, 300), rowHeight: 20, layout: 'tabbed',
        tabs: [{nodeId: 1, window: 1, title: 'One', selected: true}],
      }],
    });
    const actors = [lastCreated('border'), lastCreated('frame'), lastCreated('row')];
    for (const actor of actors) actor.destroy();
    criticals.length = 0;
    d.apply(empty);                    // the sweep must not reach any disposed actor
    expect(actors.map(actor => actor.destroyCount)).toEqual([1, 1, 1]);
    expect(criticals).toEqual([]);
  });

  it('is idempotent across two back-to-back applies of the identical plan', () => {
    // Review Focus: a nested re-entrant commit (e.g. moving a window to
    // another workspace) can call apply() twice in a row with the same plan,
    // now routed entirely through the resolver instead of global lookups.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    const plan = border(1, R(10, 20, 100, 100));
    d.apply(plan);
    const first = lastCreated('border');
    const createdCountAfterFirst = liveActors().length;
    d.apply(plan);
    expect(lastCreated('border')).toBe(first);
    expect(liveActors().length).toBe(createdCountAfterFirst);
    expect(first.destroyCount).toBe(0);
    expect(resolveCalls).toEqual([1, 1]);
    expect(criticals).toEqual([]);
  });

  it('does nothing and does not throw when a fresh instance applies an empty plan', () => {
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    expect(() => d.apply(empty)).not.toThrow();
    expect(liveActors()).toEqual([]);
    expect(disposedAccesses()).toEqual([]);
  });

  it('styles a border from the colour matching its state', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply({borders: [{window: 1, rect: R(0, 0, 10, 10), state: 'urgent', width: 3}], frames: [], titleRows: []});
    const actor = lastCreated('border');
    expect(actor.props.style).toBe(`border: 3px solid ${DEFAULT_COLORS.urgent.border};`);
  });

  it('restyles an existing border when the colours change, without a fresh plan', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(border(1));
    const custom: Colors = {
      ...DEFAULT_COLORS,
      focused: {...DEFAULT_COLORS.focused, border: '#abcdef'},
    };
    d.setColors(custom);
    const actor = lastCreated('border');
    expect(actor.props.style).toBe('border: 2px solid #abcdef;');
    expect(disposedAccesses()).toEqual([]);
  });

  it('renders a zero-width border rather than dropping it', () => {
    // A plan width of 0 is a real i3 setting (`new_window none`); the renderer
    // still owns an actor for the window, styled at 0px.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply({borders: [{window: 1, rect: R(0, 0, 10, 10), state: 'focused', width: 0}], frames: [], titleRows: []});
    const actor = lastCreated('border');
    expect(actor.props.style).toBe(`border: 0px solid ${DEFAULT_COLORS.focused.border};`);
    expect(actor.geometry).toEqual(R(0, 0, 10, 10));
  });

  it('sizes a tabbed row to one row height, not to the container it titles', () => {
    // The defect this suite missed: the box took row.rect -- the container's
    // whole rectangle -- so its reactive tab buttons covered the client area
    // and swallowed every click meant for the window.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(10, 20, 400, 300), [tab(1, 'One'), tab(2, 'Two')]));
    expect(lastCreated('row').geometry).toEqual(R(10, 20, 400, ROW_HEIGHT));
    expect(lastCreated('row').vertical).toBe(false);
    expect(criticals).toEqual([]);
  });

  it('sizes a stacked row to the whole reserved band, one row height per child', () => {
    // i3 keeps every title visible in a stacked container, so the engine
    // reserves rowHeight * children (src/tree/layout.ts) and the band holds
    // one tab per child, stacked down the axis.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(10, 20, 400, 300), [tab(1, 'One'), tab(2, 'Two'), tab(3, 'Three')], 'stacked'));
    const box = lastCreated('row');
    expect(box.geometry).toEqual(R(10, 20, 400, ROW_HEIGHT * 3));
    expect(box.vertical).toBe(true);
    // Only the size is the renderer's to set -- the box lays its children out
    // down its own axis, so each tab asks for the full width and one row.
    expect(tabActors().map(({geometry}) => [geometry.width, geometry.height])).toEqual([
      [400, ROW_HEIGHT], [400, ROW_HEIGHT], [400, ROW_HEIGHT],
    ]);
    expect(criticals).toEqual([]);
  });

  it('gives a tabbed row equal-width tabs that span it, the last absorbing the remainder', () => {
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [tab(1, 'One'), tab(2, 'Two'), tab(3, 'Three')]));
    const widths = tabActors().map(button => button.geometry.width);
    expect(widths).toEqual([133, 133, 134]);     // 400 split three ways, nothing lost
    expect(widths.reduce((a, b) => a + b, 0)).toBe(400);
  });

  it('keeps every tab inside the reserved band, clear of the client area', () => {
    // The assertion that would have caught the click-swallowing: a tab must
    // not reach below the band, whatever the layout, because everything under
    // the band belongs to the window.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    for (const layout of ['tabbed', 'stacked'] as const) {
      const rect = R(0, 100, 400, 300);
      const tabs = [tab(1, 'One'), tab(2, 'Two')];
      d.apply(row(rect, tabs, layout));
      const box = lastCreated('row');
      const rows = layout === 'stacked' ? tabs.length : 1;
      const bandBottom = rect.y + ROW_HEIGHT * rows;
      expect(box.geometry.y + box.geometry.height).toBe(bandBottom);
      for (const button of tabActors().filter(button => !button.destroyed)) {
        expect(button.geometry.height).toBeGreaterThan(0);     // sized at all
        expect(box.geometry.y + button.geometry.height).toBeLessThanOrEqual(bandBottom);
      }
      d.apply(empty);
    }
  });

  it('clamps the band to a container too short to hold it', () => {
    // src/tree/layout.ts reserves Math.min(rect.height, rowHeight * rows); the
    // renderer has to draw the same band the engine reserved, not a taller one.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(0, 0, 400, 30), [tab(1, 'One'), tab(2, 'Two')], 'stacked'));
    expect(lastCreated('row').geometry).toEqual(R(0, 0, 400, 30));
    expect(tabActors().map(button => button.geometry.height)).toEqual([15, 15]);
  });

  it('re-orients a row in place when its container switches tabbed <-> stacked', () => {
    // `layout stacked` on a tabbed container keeps the same NodeId, so the
    // same box is reused and its axis and height have to follow the plan.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    const tabs = [tab(1, 'One'), tab(2, 'Two')];
    d.apply(row(R(0, 0, 400, 300), tabs, 'tabbed'));
    const box = lastCreated('row');
    d.apply(row(R(0, 0, 400, 300), tabs, 'stacked'));
    expect(lastCreated('row')).toBe(box);
    expect(box.vertical).toBe(true);
    expect(box.geometry).toEqual(R(0, 0, 400, ROW_HEIGHT * 2));
    d.apply(row(R(0, 0, 400, 300), tabs, 'tabbed'));
    expect(box.vertical).toBe(false);
    expect(box.geometry).toEqual(R(0, 0, 400, ROW_HEIGHT));
    expect(criticals).toEqual([]);
  });

  it('follows the row height the plan carries rather than a constant of its own', () => {
    // rowHeight is measured from the theme (src/shell/rowHeight.ts) and is a
    // layout input the engine already reserved against; a HiDPI row is taller.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply(row(R(0, 0, 400, 300), [tab(1, 'One')], 'tabbed', 37));
    expect(lastCreated('row').geometry.height).toBe(37);
    expect(tabActors()[0].geometry.height).toBe(37);
  });

  it('creates and removes a frame around the focused container, keyed by nodeId', () => {
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve, defer);
    d.apply({borders: [], frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}], titleRows: []});
    const frame = lastCreated('frame');
    expect(frame.destroyed).toBe(false);
    d.apply(empty);
    expect(frame.destroyCount).toBe(1);
  });
});
