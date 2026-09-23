import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {PillState} from '../../../src/runtime/model';

vi.mock('gi://Clutter', async () => ({default: (await import('./fakes/actors')).fakeClutter}));
vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('resource:///org/gnome/shell/ui/panelMenu.js', async () =>
  (await import('./fakes/actors')).fakePanelMenu);
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {criticals, panel, resetActors, labelsOf, activeIndexOf} = await import('./fakes/actors');

interface IndicatorLike {
  setMode(name: string | null): void;
  setColors(colors: Colors): void;
  setPills(pills: PillState[]): void;
  setVisible(visible: boolean): void;
  setWorkspaces(states: PillState[]): void;
  hideActivities(): void;
  showActivities(): void;
  hide(): void;
  show(): void;
  destroy(): void;
}

// The adapter's GNOME globals belong to the native TS program, so it is loaded
// at runtime against the doubles above rather than imported statically.
const {Indicator} = await vi.importActual<{
  Indicator: new (
    colors: Colors,
    onClick: (index: number) => void,
    onScroll: (direction: 'next' | 'prev') => void,
  ) => IndicatorLike;
}>('../../../src/shell/indicator');

const pills = (count: number, active = 0): PillState[] =>
  Array.from({length: count}, (_, index) => ({
    name: String(index + 1), active: index === active, occupied: index === 0,
  }));

function indicator(): IndicatorLike {
  return new Indicator(DEFAULT_COLORS, () => {}, () => {});
}

describe('panel indicator lifetime', () => {
  beforeEach(() => resetActors());

  it('styles its pills while the panel is alive', () => {
    const bar = indicator();
    bar.setPills(pills(3, 1));
    expect(criticals).toEqual([]);
    const button = panel.button;
    expect(button).not.toBeNull();
    expect(labelsOf(button!)).toEqual(['1', '2', '3']);
    expect(activeIndexOf(button!)).toBe(1);
  });

  it('touches nothing once the shell destroys the panel button under it', () => {
    // At shutdown the panel is destroyed before disable() runs, yet
    // workareas-changed still drives a commit that publishes pills.
    const bar = indicator();
    bar.setPills(pills(3));
    panel.button!.destroy();
    expect(criticals).toEqual([]);

    bar.setPills(pills(3, 2));
    bar.setWorkspaces(pills(4));
    bar.setColors(DEFAULT_COLORS);
    bar.setMode('resize');
    bar.setMode(null);
    bar.setVisible(false);
    bar.setVisible(true);
    bar.hideActivities();
    bar.showActivities();

    expect(criticals).toEqual([]);
  });

  it('does not destroy an actor the shell already destroyed', () => {
    const bar = indicator();
    bar.setPills(pills(2));
    panel.button!.destroy();
    criticals.length = 0;

    bar.destroy();

    expect(criticals).toEqual([]);
  });

  it('still tears itself down normally when the panel is alive', () => {
    const bar = indicator();
    bar.setPills(pills(2));
    expect(panel.activitiesVisible).toBe(false);

    bar.destroy();

    expect(criticals).toEqual([]);
    expect(panel.button!.destroyed).toBe(true);
    expect(panel.activitiesVisible).toBe(true);
  });
});
