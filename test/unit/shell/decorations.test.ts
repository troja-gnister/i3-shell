import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {DecorationPlan} from '../../../src/runtime/decoration';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {WindowId} from '../../../src/tree/node';

vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {FakeActor, criticals, resetFakeActors, lastCreated, liveActors, disposedAccesses} =
  await import('./fakes/actors');

interface FakeWindowActor {
  meta_window: {get_id(): number};
}

// windowActors is what global.get_window_actors() returns; a window missing from it
// stands for one the compositor destroyed between commit and render (Task 4 brief,
// binding requirement 4).
const windowActors = new Map<WindowId, FakeWindowActor>();
const windowGroup = new FakeActor('window_group');

(globalThis as unknown as {
  global: {window_group: FakeActor; get_window_actors(): FakeWindowActor[]};
}).global = {
  window_group: windowGroup,
  get_window_actors: () => [...windowActors.values()],
};

function windowActor(id: WindowId): FakeWindowActor {
  return {meta_window: {get_id: () => id}};
}

const {Decorations} = await vi.importActual<{
  Decorations: new (
    colors: Colors,
    focus: (window: WindowId) => void,
  ) => {apply(plan: DecorationPlan): void; setColors(colors: Colors): void; destroy(): void};
}>('../../../src/shell/decorations');

const R = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const empty: DecorationPlan = {borders: [], frames: [], titleRows: []};
const border = (window: WindowId, rect = R(0, 0, 100, 100)): DecorationPlan =>
  ({borders: [{window, rect, state: 'focused' as const, width: 2}], frames: [], titleRows: []});
const row = (rect: ReturnType<typeof R>, tabs: DecorationPlan['titleRows'][number]['tabs']): DecorationPlan =>
  ({borders: [], frames: [], titleRows: [{nodeId: 7, rect, rowHeight: 20, layout: 'tabbed', tabs}]});

beforeEach(() => {
  windowActors.clear();
  resetFakeActors();
  windowGroup.children.length = 0;
});

describe('Decorations', () => {
  it('reuses a border actor when only its rectangle changed', () => {
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(border(1, R(0, 0, 100, 100)));
    const first = lastCreated('border');
    d.apply(border(1, R(50, 0, 100, 100)));
    expect(lastCreated('border')).toBe(first);
    expect(first.destroyed).toBe(false);
    expect(first.geometry).toEqual(R(50, 0, 100, 100));
  });

  it('destroys actors the plan no longer contains', () => {
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(border(1));
    const actor = lastCreated('border');
    d.apply(empty);
    expect(actor.destroyCount).toBe(1);
    expect(actor.destroyed).toBe(true);
  });

  it('keys title rows by nodeId, not by rectangle', () => {
    windowActors.set(1, windowActor(1));
    const tabs = [{nodeId: 1, window: 1 as WindowId, title: 'One', selected: true}];
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(row(R(0, 0, 400, 300), tabs));
    const first = lastCreated('row');
    d.apply(row(R(0, 0, 200, 300), tabs));
    // A rectangle key would have destroyed and rebuilt an actor that only moved.
    expect(lastCreated('row')).toBe(first);
    expect(first.destroyCount).toBe(0);
    expect(first.geometry).toEqual(R(0, 0, 200, 300));
  });

  it('skips a window whose actor has gone away between plan and render', () => {
    // Review Focus: the plan names a WindowId; the window may be gone by now.
    const d = new Decorations(DEFAULT_COLORS, () => {});
    expect(() => d.apply(border(99))).not.toThrow();
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors().filter(actor => actor.props.style_class === 'i3-shell-border')).toEqual([]);
  });

  it('does not interpret markup in a tab title', () => {
    // Review Focus: titles come from arbitrary applications.
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: '<b>x</b>', selected: true}]));
    const tab = lastCreated('tab');
    expect(tab.label).toBe('<b>x</b>');
    expect(tab.useMarkup).toBe(false);
  });

  it('focuses the tab that was clicked, without touching the tree', () => {
    windowActors.set(1, windowActor(1));
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w));
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: 1, title: 'One', selected: false}]));
    lastCreated('tab').emit('clicked');
    expect(focused).toEqual([1]);
  });

  it('does not focus anything for a nested-container tab, whose window is null', () => {
    // Review Focus: a tab's window is WindowId | null; a nested-container tab has null.
    const focused: WindowId[] = [];
    const d = new Decorations(DEFAULT_COLORS, w => focused.push(w));
    d.apply(row(R(0, 0, 400, 300), [{nodeId: 1, window: null, title: 'Nested', selected: false}]));
    expect(() => lastCreated('tab').emit('clicked')).not.toThrow();
    expect(focused).toEqual([]);
  });

  it('destroys every actor on destroy(), and touches none afterwards', () => {
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply({...border(1), frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}]});
    d.destroy();
    d.destroy();                       // idempotent, as disable() is
    expect(disposedAccesses()).toEqual([]);
    expect(liveActors()).toEqual([]);
  });

  it('is idempotent across two back-to-back applies of the identical plan', () => {
    // Review Focus: a nested re-entrant commit (e.g. moving a window to
    // another workspace) can call apply() twice in a row with the same plan.
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    const plan = border(1, R(10, 20, 100, 100));
    d.apply(plan);
    const first = lastCreated('border');
    const createdCountAfterFirst = liveActors().length;
    d.apply(plan);
    expect(lastCreated('border')).toBe(first);
    expect(liveActors().length).toBe(createdCountAfterFirst);
    expect(first.destroyCount).toBe(0);
    expect(criticals).toEqual([]);
  });

  it('does nothing and does not throw when a fresh instance applies an empty plan', () => {
    const d = new Decorations(DEFAULT_COLORS, () => {});
    expect(() => d.apply(empty)).not.toThrow();
    expect(liveActors()).toEqual([]);
    expect(disposedAccesses()).toEqual([]);
  });

  it('styles a border from the colour matching its state', () => {
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply({borders: [{window: 1, rect: R(0, 0, 10, 10), state: 'urgent', width: 3}], frames: [], titleRows: []});
    const actor = lastCreated('border');
    expect(actor.props.style).toBe(`border: 3px solid ${DEFAULT_COLORS.urgent.border};`);
  });

  it('restyles an existing border when the colours change, without a fresh plan', () => {
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
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
    windowActors.set(1, windowActor(1));
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply({borders: [{window: 1, rect: R(0, 0, 10, 10), state: 'focused', width: 0}], frames: [], titleRows: []});
    expect(() => lastCreated('border')).not.toThrow();
  });

  it('creates and removes a frame around the focused container, keyed by nodeId', () => {
    const d = new Decorations(DEFAULT_COLORS, () => {});
    d.apply({borders: [], frames: [{nodeId: 3, rect: R(0, 0, 400, 300)}], titleRows: []});
    const frame = lastCreated('frame');
    expect(frame.destroyed).toBe(false);
    d.apply(empty);
    expect(frame.destroyCount).toBe(1);
  });
});
