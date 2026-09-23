import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DecorationPlan} from '../../../src/runtime/decoration';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {WindowId} from '../../../src/tree/node';

vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {FakeActor, criticals, resetFakeActors, lastCreated, liveActors, disposedAccesses} =
  await import('./fakes/actors');

const windowGroup = new FakeActor('window_group');

(globalThis as unknown as {global: {window_group: FakeActor}}).global = {
  window_group: windowGroup,
};

interface FakeMetaWindow {
  get_compositor_private(): FakeActor | null;
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

function fakeWindow(actor: FakeActor | null = new FakeActor('meta-window-actor')): FakeMetaWindow {
  return {get_compositor_private: () => actor};
}

const {Decorations} = await vi.importActual<{
  Decorations: new (
    colors: Colors,
    focus: (window: WindowId) => void,
    resolve: (id: WindowId) => FakeMetaWindow | undefined,
  ) => {apply(plan: DecorationPlan): void; setColors(colors: Colors): void; destroy(): void};
}>('../../../src/shell/decorations');

const R = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const empty: DecorationPlan = {borders: [], frames: [], titleRows: []};
const border = (window: WindowId, rect = R(0, 0, 100, 100)): DecorationPlan =>
  ({borders: [{window, rect, state: 'focused' as const, width: 2}], frames: [], titleRows: []});
const row = (rect: ReturnType<typeof R>, tabs: DecorationPlan['titleRows'][number]['tabs']): DecorationPlan =>
  ({borders: [], frames: [], titleRows: [{nodeId: 7, rect, rowHeight: 20, layout: 'tabbed', tabs}]});

beforeEach(() => {
  resolvable.clear();
  resolveCalls.length = 0;
  resetFakeActors();
  windowGroup.children.length = 0;
});

describe('Decorations', () => {
  it('reuses a border actor when only its rectangle changed', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply(border(1, R(0, 0, 100, 100)));
    const first = lastCreated('border');
    d.apply(border(1, R(50, 0, 100, 100)));
    expect(lastCreated('border')).toBe(first);
    expect(first.destroyed).toBe(false);
    expect(first.geometry).toEqual(R(50, 0, 100, 100));
  });

  it('destroys actors the plan no longer contains', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply(border(1));
    const actor = lastCreated('border');
    d.apply(empty);
    expect(actor.destroyCount).toBe(1);
    expect(actor.destroyed).toBe(true);
  });

  it('keys title rows by nodeId, not by rectangle', () => {
    resolvable.set(1, fakeWindow());
    const tabs = [{nodeId: 1, window: 1 as WindowId, title: 'One', selected: true}];
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply(row(R(0, 0, 400, 300), tabs));
    const first = lastCreated('row');
    d.apply(row(R(0, 0, 200, 300), tabs));
    // A rectangle key would have destroyed and rebuilt an actor that only moved.
    expect(lastCreated('row')).toBe(first);
    expect(first.destroyCount).toBe(0);
    expect(first.geometry).toEqual(R(0, 0, 200, 300));
  });

  it('skips a window when the resolver finds nothing, without touching a disposed actor', () => {
    // Review Focus: the plan names a WindowId; by render time the window may
    // be gone (resolve() misses) or its compositor actor may not exist yet
    // (get_compositor_private() returns null) -- either way, skip silently.
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
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
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply(border(42));
    expect(resolveCalls).toEqual([42]);
  });

  it('skips a window whose window actor is null, e.g. before its first frame', () => {
    // get_compositor_private() returns null until Mutter has an actor for the
    // window; @girs types it non-nullable (see src/shell/windows.ts's cast).
    resolvable.set(1, fakeWindow(null));
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    expect(() => d.apply(border(1))).not.toThrow();
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors().filter(actor => actor.props.style_class === 'i3-shell-border')).toEqual([]);
  });

  it('does not interpret markup in a tab title', () => {
    // Review Focus: titles come from arbitrary applications.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: '<b>x</b>', selected: true}]));
    const tab = lastCreated('tab');
    expect(tab.label).toBe('<b>x</b>');
    expect(tab.useMarkup).toBe(false);
  });

  it('focuses the tab that was clicked, without touching the tree', () => {
    resolvable.set(1, fakeWindow());
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w), resolve);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: 'One', selected: false}]));
    lastCreated('tab').emit('clicked');
    expect(focused).toEqual([1]);
  });

  it('does not focus anything for a nested-container tab, whose window is null', () => {
    // Review Focus: a tab's window is WindowId | null; a nested-container tab has null.
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w), resolve);
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: null, title: 'Nested', selected: false}]));
    expect(() => lastCreated('tab').emit('clicked')).not.toThrow();
    expect(focused).toEqual([]);
  });

  it('destroys every actor on destroy(), and touches none afterwards', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply({...border(1), frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}]});
    d.destroy();
    d.destroy();                       // idempotent, as disable() is
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors()).toEqual([]);
  });

  it('is idempotent across two back-to-back applies of the identical plan', () => {
    // Review Focus: a nested re-entrant commit (e.g. moving a window to
    // another workspace) can call apply() twice in a row with the same plan,
    // now routed entirely through the resolver instead of global lookups.
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
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
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    expect(() => d.apply(empty)).not.toThrow();
    expect(liveActors()).toEqual([]);
    expect(disposedAccesses()).toEqual([]);
  });

  it('styles a border from the colour matching its state', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply({borders: [{window: 1, rect: R(0, 0, 10, 10), state: 'urgent', width: 3}], frames: [], titleRows: []});
    const actor = lastCreated('border');
    expect(actor.props.style).toBe(`border: 3px solid ${DEFAULT_COLORS.urgent.border};`);
  });

  it('restyles an existing border when the colours change, without a fresh plan', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
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

  it('still creates a border with a plan width of zero', () => {
    resolvable.set(1, fakeWindow());
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply({borders: [{window: 1, rect: R(0, 0, 10, 10), state: 'focused', width: 0}], frames: [], titleRows: []});
    expect(() => lastCreated('border')).not.toThrow();
  });

  it('creates and removes a frame around the focused container, keyed by nodeId', () => {
    const d = new Decorations(DEFAULT_COLORS, () => {}, resolve);
    d.apply({borders: [], frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}], titleRows: []});
    const frame = lastCreated('frame');
    expect(frame.destroyed).toBe(false);
    d.apply(empty);
    expect(frame.destroyCount).toBe(1);
  });
});
