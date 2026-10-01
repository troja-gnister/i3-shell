import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {PillState} from '../../../src/runtime/model';
import type {MonitorId} from '../../../src/tree/node';
import {samePills, stylePill} from '../../../src/shell/util/pills';
import type {FakeActor} from './fakes/actors';
import St from 'gi://St';

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
  MonitorBars: new (
    onPill: (output: MonitorId, position: number) => void,
    monitorId: (index: number) => MonitorId | undefined,
  ) => {
    setPills(byOutput: ReadonlyMap<MonitorId, readonly PillState[]>): void;
    setMode(name: string | null): void;
    setColors(colors: Colors): void;
    monitorsChanged(): void;
  };
}>('../../../src/shell/bars');

// The fixture's one non-primary monitor sits at Mutter index 1; the identity mapping keeps that bar's
// own output id readable at a glance in every assertion below.
const monitorId = (index: number): MonitorId => index;
const BAR_OUTPUT = 1;
const singleBar = (states: PillState[]): Map<MonitorId, readonly PillState[]> => new Map([[BAR_OUTPUT, states]]);

/** `St.Button`'s ambient type has no `.props`; the fake actor underneath it is where every style lands. */
const styleOf = (button: St.Button): unknown => (button as unknown as FakeActor).props.style;

// Deliberately nothing like the defaults: a field read from the wrong colour
// set on one side and the right one on the other has to show up as a difference.
const COLORS: Colors = {
  focused: {border: '#111111', background: '#112233', text: '#f0f0f0', indicator: '#113355', childBorder: '#112233'},
  focusedInactive: {border: '#222222', background: '#445566', text: '#e0e0e0', indicator: '#446688', childBorder: '#445566'},
  unfocused: {border: '#333333', background: '#778899', text: '#d0d0d0', indicator: '#7788aa', childBorder: '#778899'},
  urgent: {border: '#444444', background: '#aabbcc', text: '#c0c0c0', indicator: '#aabbdd', childBorder: '#aabbcc'},
};

const pills: PillState[] = [
  {name: '1:I', focused: false, visible: false, occupied: true, urgent: false},
  {name: '2:II', focused: true, visible: true, occupied: true, urgent: false},
  {name: '3:III', focused: false, visible: false, occupied: false, urgent: false},   // empty: the dimmed case
];

const urgentPills: PillState[] = [
  {name: '1:I', focused: false, visible: false, occupied: true, urgent: false},
  {name: '2:II', focused: true, visible: true, occupied: true, urgent: false},
  {name: '3:III', focused: false, visible: false, occupied: true, urgent: true},   // urgent: the case under test
];

// The engine never derives this combination -- a focused workspace is never
// urgent (src/engine.ts clears it) -- but stylePill's branch order still has
// to prefer `focused` on its own, because that invariant lives one layer away
// and nothing here re-checks it.
const focusedAndUrgentPills: PillState[] = [
  {name: '1:I', focused: true, visible: true, occupied: true, urgent: true},
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

describe('samePills', () => {
  it('repaints when only urgency changed', () => {
    // samePills is the repaint guard. Without the urgent comparison an urgency
    // flip with an unchanged name, active and occupied reports "same", the bar
    // skips the repaint, and the feature is dead at runtime while every
    // derivation test stays green. Same length on both sides on purpose: a
    // length mismatch short-circuits before the comparison is reached, which is
    // why the render test above cannot cover this.
    const before = [{name: '1:I', focused: false, visible: false, occupied: true, urgent: false}];
    const after  = [{name: '1:I', focused: false, visible: false, occupied: true, urgent: true}];
    expect(samePills(before, after)).toBe(false);
    expect(samePills(before, before)).toBe(true);
  });
});

const pill = (over: Partial<PillState> = {}): PillState =>
  ({name: 'I', focused: false, visible: false, occupied: false, urgent: false, ...over});

describe('Task 8: focused vs visible', () => {
  it('samePills compares all five fields', () => {
    expect(samePills([pill()], [pill({visible: true})])).toBe(false);
    expect(samePills([pill()], [pill({focused: true})])).toBe(false);
    expect(samePills([pill()], [pill({urgent: true})])).toBe(false);
    expect(samePills([pill()], [pill({occupied: true})])).toBe(false);
    expect(samePills([pill()], [pill({name: 'II'})])).toBe(false);
    expect(samePills([pill()], [pill()])).toBe(true);
  });

  it('styles focused ahead of urgent', () => {
    const button = new St.Button({});
    stylePill(button, pill({focused: true, urgent: true, visible: true}), COLORS);
    // The brief's own example calls a `get_style()` that does not exist anywhere in this codebase
    // (neither the real St.Button nor this fake) -- the fake records the inline style on `props.style`,
    // which is what every other test in this file reads via `styleOf`. Adapted rather than followed
    // literally.
    expect(String(styleOf(button))).toContain(COLORS.focused.background);
  });

  it('styles urgent ahead of visible', () => {
    const button = new St.Button({});
    stylePill(button, pill({urgent: true, visible: true}), COLORS);
    expect(String(styleOf(button))).toContain(COLORS.urgent.background);
  });

  it('styles a workspace visible on another output distinctly from an idle one', () => {
    const onOther = new St.Button({});
    stylePill(onOther, pill({visible: true, occupied: true}), COLORS);
    const idle = new St.Button({});
    stylePill(idle, pill({occupied: true}), COLORS);
    expect(styleOf(onOther)).not.toEqual(styleOf(idle));
    expect(String(styleOf(onOther))).toContain(COLORS.focusedInactive.background);
  });

  it('keeps the urgent ring off a focused pill', () => {
    const button = new St.Button({});
    stylePill(button, pill({focused: true, urgent: true}), COLORS);
    expect(button.style_class).toBe('i3-shell-ws');
  });
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
    const bars = new MonitorBars(() => {}, monitorId);
    bars.setColors(COLORS);
    indicator.setPills(states);
    bars.setPills(singleBar(states));
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

  it('gives an urgent, inactive pill the client.urgent background on both renderings', () => {
    const [button, bar] = bothWith(urgentPills);

    expect(styles(bar)).toEqual(styles(button));
    expect(String(styles(bar)[2])).toContain(COLORS.urgent.background);
    expect(String(styles(bar)[2])).toContain(COLORS.urgent.text);
    // The non-urgent pills are unaffected.
    expect(String(styles(bar)[0])).not.toContain(COLORS.urgent.background);
    expect(String(styles(bar)[1])).toContain(COLORS.focused.background);
  });

  it('renders a pill that is both focused and urgent as focused, not urgent', () => {
    const [button, bar] = bothWith(focusedAndUrgentPills);

    expect(styles(bar)).toEqual(styles(button));
    expect(String(styles(bar)[0])).toContain(COLORS.focused.background);
    expect(String(styles(bar)[0])).not.toContain(COLORS.urgent.background);
  });

  it('gives every pill the same label, style and opacity', () => {
    const [button, bar] = bothWith(pills);

    expect(labelsOf(bar)).toEqual(labelsOf(button));
    expect(labelsOf(bar)).toEqual(['1:I', '2:II', '3:III']);
    expect(styles(bar)).toEqual(styles(button));
    expect(opacities(bar)).toEqual(opacities(button));
    // Not a tautology if both sides were blank: the look is pinned too.
    expect(opacities(bar)).toEqual([255, 255, 128]);
    expect(activeIndexOf(bar, COLORS)).toBe(activeIndexOf(button, COLORS));
    expect(activeIndexOf(bar, COLORS)).toBe(1);
  });

  it('keeps them the same after the colours change under both', () => {
    const indicator = new Indicator(COLORS, () => {}, () => {});
    const bars = new MonitorBars(() => {}, monitorId);
    bars.setColors(COLORS);
    indicator.setPills(pills);
    bars.setPills(singleBar(pills));

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

  it('reports the same clicked position from either click target, plus the bar\'s own output', () => {
    const fromPanel: number[] = [];
    const fromBar: Array<[MonitorId, number]> = [];
    const indicator = new Indicator(COLORS, index => fromPanel.push(index), () => {});
    const bars = new MonitorBars((output, position) => fromBar.push([output, position]), monitorId);
    indicator.setPills(pills);
    bars.setPills(singleBar(pills));

    pillsOf(panel.button as FakeActor)[2].emit('clicked');
    pillsOf(trackedChrome()[0])[2].emit('clicked');

    expect(fromBar.map(([, position]) => position)).toEqual(fromPanel);
    expect(fromPanel).toEqual([2]);
    expect(fromBar).toEqual([[BAR_OUTPUT, 2]]);
  });
});
