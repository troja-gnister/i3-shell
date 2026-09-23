import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {PillState} from '../../../src/runtime/model';
import type {FakeActor} from './fakes/actors';

vi.mock('gi://Clutter', async () => ({default: (await import('./fakes/actors')).fakeClutter}));
vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('resource:///org/gnome/shell/ui/panelMenu.js', async () =>
  (await import('./fakes/actors')).fakePanelMenu);
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {
  panel, layout, trackedChrome, resetFakeActors, criticals, pillsOf, labelsOf, activeIndexOf, modeLabelOf,
} = await import('./fakes/actors');

interface PillRenderer {
  setPills(pills: PillState[]): void;
  setMode(name: string | null): void;
  setColors(colors: Colors): void;
}

const {Indicator} = await vi.importActual<{
  Indicator: new (
    colors: Colors,
    onClick: (index: number) => void,
    onScroll: (direction: 'next' | 'prev') => void,
  ) => PillRenderer;
}>('../../../src/shell/indicator');

const {MonitorBars} = await vi.importActual<{
  MonitorBars: new (onPill: (index: number) => void) => PillRenderer & {monitorsChanged(): void};
}>('../../../src/shell/bars');

// Deliberately nothing like the defaults: a field read from the wrong colour
// set on one side and the right one on the other has to show up as a difference.
const COLORS: Colors = {
  focused: {border: '#111111', background: '#112233', text: '#f0f0f0', indicator: '#113355', childBorder: '#112233'},
  focusedInactive: {border: '#222222', background: '#445566', text: '#e0e0e0', indicator: '#446688', childBorder: '#445566'},
  unfocused: {border: '#333333', background: '#778899', text: '#d0d0d0', indicator: '#7788aa', childBorder: '#778899'},
  urgent: {border: '#444444', background: '#aabbcc', text: '#c0c0c0', indicator: '#aabbdd', childBorder: '#aabbcc'},
};

const pills: PillState[] = [
  {name: '1:I', active: false, occupied: true},
  {name: '2:II', active: true, occupied: true},
  {name: '3:III', active: false, occupied: false},   // empty: the dimmed case
];

const styles = (root: FakeActor): unknown[] => pillsOf(root).map(pill => pill.props.style);
const opacities = (root: FakeActor): number[] => pillsOf(root).map(pill => pill.opacity);
const kinds = (root: FakeActor): string[] => pillsOf(root).map(pill => pill.kind);
const props = (root: FakeActor): Array<Record<string, unknown>> => pillsOf(root).map(pill => pill.props);

beforeEach(() => {
  resetFakeActors();
  // One non-primary monitor, so there is exactly one bar to compare against.
  layout.monitors = [
    {index: 0, x: 0, y: 0, width: 1728, height: 1048},
    {index: 1, x: 1728, y: 0, width: 1920, height: 1080},
  ];
  layout.primaryIndex = 0;
});

/**
 * The panel indicator and the monitor bars are two renderings of one thing, and
 * users see both at once on a multi-monitor desktop, so they are required to
 * look the same. Each suite otherwise asserts against its own copy of the
 * expected look, which would let a colour or opacity change in one file diverge
 * silently with both suites green. These tests pin the contract itself.
 */
describe('the panel and a monitor bar render the same pills', () => {
  function bothWith(states: PillState[], mode: string | null = null): [FakeActor, FakeActor] {
    const indicator = new Indicator(COLORS, () => {}, () => {});
    const bars = new MonitorBars(() => {});
    bars.setColors(COLORS);
    indicator.setPills(states);
    bars.setPills(states);
    indicator.setMode(mode);
    bars.setMode(mode);
    const button = panel.button;
    expect(button).not.toBeNull();
    return [button as FakeActor, trackedChrome()[0]];
  }

  it('builds the same pill actors with the same properties', () => {
    const [button, bar] = bothWith(pills);

    expect(kinds(bar)).toEqual(kinds(button));
    expect(props(bar)).toEqual(props(button));
  });

  it('gives every pill the same label, style and opacity', () => {
    const [button, bar] = bothWith(pills);

    expect(labelsOf(bar)).toEqual(labelsOf(button));
    expect(labelsOf(bar)).toEqual(['1:I', '2:II', '3:III']);
    expect(styles(bar)).toEqual(styles(button));
    expect(opacities(bar)).toEqual(opacities(button));
    // Not a tautology if both sides were blank: the look is pinned too.
    expect(opacities(bar)).toEqual([255, 255, 128]);
    expect(activeIndexOf(bar)).toBe(activeIndexOf(button));
    expect(activeIndexOf(bar)).toBe(1);
  });

  it('keeps them the same after the colours change under both', () => {
    const indicator = new Indicator(COLORS, () => {}, () => {});
    const bars = new MonitorBars(() => {});
    bars.setColors(COLORS);
    indicator.setPills(pills);
    bars.setPills(pills);

    indicator.setColors(DEFAULT_COLORS);
    bars.setColors(DEFAULT_COLORS);

    const button = panel.button as FakeActor;
    const bar = trackedChrome()[0];
    expect(styles(bar)).toEqual(styles(button));
    expect(String(styles(bar)[1])).toContain(DEFAULT_COLORS.focused.background);
  });

  it('renders the binding mode the same way', () => {
    const [button, bar] = bothWith(pills, 'resize');

    expect(modeLabelOf(bar)?.text).toBe(modeLabelOf(button)?.text);
    expect(modeLabelOf(bar)?.props.style).toBe(modeLabelOf(button)?.props.style);
    expect(modeLabelOf(bar)?.visible).toBe(modeLabelOf(button)?.visible);
  });

  it('renders an empty workspace list the same way', () => {
    const [button, bar] = bothWith([]);

    expect(pillsOf(bar)).toEqual([]);
    expect(pillsOf(button)).toEqual([]);
    expect(criticals).toEqual([]);
  });

  it('reports the same workspace index from either click target', () => {
    const fromPanel: number[] = [];
    const fromBar: number[] = [];
    const indicator = new Indicator(COLORS, index => fromPanel.push(index), () => {});
    const bars = new MonitorBars(index => fromBar.push(index));
    indicator.setPills(pills);
    bars.setPills(pills);

    pillsOf(panel.button as FakeActor)[2].emit('clicked');
    pillsOf(trackedChrome()[0])[2].emit('clicked');

    expect(fromBar).toEqual(fromPanel);
    expect(fromBar).toEqual([2]);
  });
});
