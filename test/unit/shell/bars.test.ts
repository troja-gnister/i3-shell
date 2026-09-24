import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DEFAULT_COLORS} from '../../../src/config/model';
import type {Colors} from '../../../src/config/model';
import type {PillState} from '../../../src/runtime/model';
// Type-only: the classes themselves come in through the dynamic import below, so
// they resolve through the same mocked module `gi://St` does; this import
// contributes no runtime code.
import type {FakeActor} from './fakes/actors';

vi.mock('gi://Clutter', async () => ({default: (await import('./fakes/actors')).fakeClutter}));
vi.mock('gi://St', async () => ({default: (await import('./fakes/actors')).fakeSt}));
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
// guard() (src/shell/util/signals.ts) logs through this when a pill's callback throws.
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {
  criticals, layout, trackedChrome, resetFakeActors, liveActors, disposedAccesses, created,
  pillsOf, labelsOf, activeIndexOf, modeLabelOf,
} = await import('./fakes/actors');

type Actor = FakeActor;

interface MonitorBarsLike {
  setPills(pills: PillState[]): void;
  setMode(name: string | null): void;
  setColors(colors: Colors): void;
  setVisible(visible: boolean): void;
  monitorsChanged(): void;
  destroy(): void;
}

// The adapter's GNOME globals belong to the native TS program, so it is loaded
// at runtime against the doubles above rather than imported statically.
const {MonitorBars} = await vi.importActual<{
  MonitorBars: new (onPill: (index: number) => void) => MonitorBarsLike;
}>('../../../src/shell/bars');

const monitor = (index: number, x: number, width: number, height: number) =>
  ({index, x, y: 0, width, height});

/** Two monitors side by side, the left one primary -- one bar, on the right-hand screen. */
const TWO = [monitor(0, 0, 1728, 1048), monitor(1, 1728, 1920, 1080)];

const pills: PillState[] = [
  {name: '1:I', active: true, occupied: true},
  {name: '2:II', active: false, occupied: false},
];

/** Every bar currently in the chrome, in the order it was added. */
const bars = (): Actor[] => trackedChrome();

/** The box holding a bar's pills: what the theme actually sizes. */
const contentBoxOf = (bar: Actor): Actor => bar.children[0];

beforeEach(() => {
  resetFakeActors();
  layout.monitors = [...TWO];
  layout.primaryIndex = 0;
});

describe('MonitorBars', () => {
  it('creates one bar per non-primary monitor and none for the primary', () => {
    new MonitorBars(() => {});

    expect(bars()).toHaveLength(1);
    expect(bars()[0].geometry.x).toBe(1728);
  });

  it('leaves the primary alone wherever it sits', () => {
    layout.monitors = [monitor(0, 0, 1728, 1048), monitor(1, 1728, 1920, 1080), monitor(2, 3648, 1280, 1024)];
    layout.primaryIndex = 1;

    new MonitorBars(() => {});

    expect(bars().map(bar => bar.geometry.x)).toEqual([0, 3648]);
  });

  it('reserves strut space along the monitor edge', () => {
    new MonitorBars(() => {});

    expect(layout.chrome[0].params.affectsStruts).toBe(true);
    expect(layout.chrome[0].params.trackFullscreen).toBe(true);
    expect(bars()[0].geometry.y).toBe(0);
    expect(bars()[0].geometry.width).toBe(1920);
    expect(bars()[0].geometry.height).toBeGreaterThan(0);
  });

  it('grows past the fixed height when the themed content is taller', () => {
    // Review Focus: the bar's height is a constant but everything inside it is
    // sized by the theme -- font, padding, scale factor. On a monitor with a
    // different scale factor the pills outgrow the constant, so a fixed height
    // clips them and the strut under-reserves the work area.
    const monitorBars = new MonitorBars(() => {});
    contentBoxOf(bars()[0]).preferredHeight = 44;

    monitorBars.setPills(pills);

    expect(bars()[0].geometry.height).toBe(44);
  });

  it('keeps the fixed height as a floor when the content is smaller', () => {
    const monitorBars = new MonitorBars(() => {});
    contentBoxOf(bars()[0]).preferredHeight = 10;

    monitorBars.setPills(pills);

    expect(bars()[0].geometry.height).toBe(28);
  });

  it('falls back to the floor when the actor reports no usable height', () => {
    const monitorBars = new MonitorBars(() => {});
    contentBoxOf(bars()[0]).preferredHeight = Number.NaN;

    monitorBars.setPills(pills);

    expect(bars()[0].geometry.height).toBe(28);
  });

  it('regrows when the binding mode makes the content taller', () => {
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);
    contentBoxOf(bars()[0]).preferredHeight = 40;

    monitorBars.setMode('resize');

    expect(bars()[0].geometry.height).toBe(40);
  });

  it('mirrors the same pills onto every bar', () => {
    layout.monitors = [monitor(0, 0, 1728, 1048), monitor(1, 1728, 1920, 1080), monitor(2, 3648, 1280, 1024)];
    const monitorBars = new MonitorBars(() => {});

    monitorBars.setPills(pills);

    expect(bars()).toHaveLength(2);
    for (const bar of bars()) {
      expect(labelsOf(bar)).toEqual(['1:I', '2:II']);
      expect(activeIndexOf(bar)).toBe(0);
    }
  });

  it('shows the pills the layout already had on a bar built later', () => {
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);
    monitorBars.setMode('resize');

    layout.monitors = [...TWO, monitor(2, 3648, 1280, 1024)];
    monitorBars.monitorsChanged();

    expect(bars()).toHaveLength(2);
    expect(labelsOf(bars()[1])).toEqual(['1:I', '2:II']);
    expect(modeLabelOf(bars()[1])?.text).toBe('resize');
    expect(modeLabelOf(bars()[1])?.visible).toBe(true);
  });

  it('switches the shared workspace when a mirrored pill is clicked', () => {
    const switched: number[] = [];
    const monitorBars = new MonitorBars(index => switched.push(index));
    monitorBars.setPills(pills);

    pillsOf(bars()[0])[1].emit('clicked');

    expect(switched).toEqual([1]);
  });

  it('reports each pill\'s own index after the pills are renumbered', () => {
    const switched: number[] = [];
    const monitorBars = new MonitorBars(index => switched.push(index));
    monitorBars.setPills(pills);
    monitorBars.setPills([...pills, {name: '3:III', active: false, occupied: true}]);

    pillsOf(bars()[0])[2].emit('clicked');

    expect(switched).toEqual([2]);
  });

  it('touches nothing when the published pills are unchanged', () => {
    // The engine publishes pills on every commit and most are identical;
    // restyling every pill on every monitor is pure cost on the compositor
    // thread. The sentinel survives only if the bar was left alone.
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);
    pillsOf(bars()[0])[0].set_style('sentinel');

    monitorBars.setPills(pills.map(pill => ({...pill})));

    expect(pillsOf(bars()[0])[0].props.style).toBe('sentinel');
  });

  it('updates the pills in place rather than rebuilding them', () => {
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);
    const before = pillsOf(bars()[0]);
    const createdBefore = created.length;

    monitorBars.setPills([
      {name: '1:I', active: false, occupied: true},
      {name: '2:II', active: true, occupied: true},
    ]);
    monitorBars.setColors(DEFAULT_COLORS);

    expect(pillsOf(bars()[0])[0]).toBe(before[0]);
    expect(pillsOf(bars()[0])[1]).toBe(before[1]);
    expect(created.length).toBe(createdBefore);
    expect(criticals).toEqual([]);
  });

  it('drops the pills of workspaces that have gone', () => {
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills([...pills, {name: '3:III', active: false, occupied: true}]);

    monitorBars.setPills(pills);

    expect(labelsOf(bars()[0])).toEqual(['1:I', '2:II']);
    expect(criticals).toEqual([]);
  });

  it('puts a pill the shell destroyed under it back in its own place', () => {
    // Review Focus: with the pills held in an array, a pill disposed behind
    // this class's back would shift every pill after it, so clicking "3"
    // would switch to workspace 2.
    const three = [...pills, {name: '3:III', active: false, occupied: true}];
    const switched: number[] = [];
    const monitorBars = new MonitorBars(index => switched.push(index));
    monitorBars.setPills(three);

    pillsOf(bars()[0])[1].destroy();
    criticals.length = 0;
    monitorBars.setPills(three.map((pill, index) => ({...pill, active: index === 2})));

    expect(labelsOf(bars()[0])).toEqual(['1:I', '2:II', '3:III']);
    expect(activeIndexOf(bars()[0])).toBe(2);
    pillsOf(bars()[0])[2].emit('clicked');
    expect(switched).toEqual([2]);
    expect(criticals).toEqual([]);
  });

  it('moves the highlight when the active workspace changes', () => {
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);

    monitorBars.setPills([
      {name: '1:I', active: false, occupied: true},
      {name: '2:II', active: true, occupied: true},
    ]);

    expect(activeIndexOf(bars()[0])).toBe(1);
  });

  it('paints the bar itself with the configured background', () => {
    // Without a background the pills would float over the wallpaper, and the
    // strut would reserve a band of desktop that looks like a gap.
    const monitorBars = new MonitorBars(() => {});

    monitorBars.setColors({
      ...DEFAULT_COLORS,
      unfocused: {...DEFAULT_COLORS.unfocused, background: '#010203'},
    });

    expect(String(bars()[0].props.style ?? '')).toContain('#010203');
  });

  it('shows the binding mode on every bar and hides it again', () => {
    const monitorBars = new MonitorBars(() => {});

    monitorBars.setMode('resize');
    expect(modeLabelOf(bars()[0])?.text).toBe('resize');
    expect(modeLabelOf(bars()[0])?.visible).toBe(true);

    monitorBars.setMode(null);
    expect(modeLabelOf(bars()[0])?.visible).toBe(false);
  });

  it('removes a bar and releases its strut when its monitor goes away', () => {
    // Review Focus: a stale strut would shrink the work area of a monitor
    // that no longer exists.
    const monitorBars = new MonitorBars(() => {});
    const actor = bars()[0];

    layout.monitors = [TWO[0]];
    monitorBars.monitorsChanged();

    expect(layout.untracked).toContain(actor);
    expect(actor.destroyCount).toBe(1);
    expect(bars()).toEqual([]);
    expect(disposedAccesses()).toEqual([]);
  });

  it('hides every bar when the session has no windows, and shows them again', () => {
    const monitorBars = new MonitorBars(() => {});

    monitorBars.setVisible(false);
    expect(bars()[0].visible).toBe(false);

    monitorBars.setVisible(true);
    expect(bars()[0].visible).toBe(true);
  });

  it('builds a bar hidden when the session is hidden', () => {
    // Review Focus: a monitor plugged in while the screen is locked must not
    // put a workspace bar on top of the lock screen.
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setVisible(false);

    layout.monitors = [...TWO, monitor(2, 3648, 1280, 1024)];
    monitorBars.monitorsChanged();

    expect(bars().map(bar => bar.visible)).toEqual([false, false]);
  });

  it('destroys every bar on destroy(), and touches none afterwards', () => {
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);

    monitorBars.destroy();
    monitorBars.destroy();

    expect(disposedAccesses()).toEqual([]);
    expect(liveActors()).toEqual([]);
    expect(bars()).toEqual([]);
  });

  it('touches nothing once the shell destroys a bar under it', () => {
    // At shutdown the chrome goes before disable() runs, yet a last commit
    // still publishes pills. src/shell/indicator.ts guards the same hazard.
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);
    bars()[0].destroy();
    criticals.length = 0;

    monitorBars.setPills([{name: '9', active: true, occupied: true}]);
    monitorBars.setColors(DEFAULT_COLORS);
    monitorBars.setMode('resize');
    monitorBars.setMode(null);
    monitorBars.setVisible(false);
    monitorBars.setVisible(true);
    monitorBars.destroy();

    expect(criticals).toEqual([]);
  });

  it('records a write to a disposed bar, so the assertions above can fail', () => {
    // The `criticals` assertions above are `toEqual([])`, so a recorder that
    // never fires would make them all pass vacuously. This one fires it.
    new MonitorBars(() => {});
    const actor = bars()[0];
    actor.destroy();

    actor.set_position(0, 0);

    expect(criticals).toEqual(['St.BoxLayout.set_position after dispose']);
    criticals.length = 0;
  });

  it('touches no theme node, and falls back to the floor, once the shell ' +
     'unparents a bar without destroying it', () => {
    // Task 9's native run found the gap this closes: at shutdown the shell
    // can unparent chrome from the stage without ever destroying it, so the
    // per-bar 'destroy' listener above -- which is what the previous test
    // relies on -- never fires and the bar stays in `_bars`. A workspace
    // count change firing later (the extension's own signal handlers are
    // still connected; disable() has not run) must not ask this bar's
    // now-stageless actor for a theme node: doing so is what produced
    // `St-CRITICAL: ... which is not in the stage` and, by the same query
    // resolving a scale-aware property, `libmutter-CRITICAL:
    // meta_display_get_monitor_scale: assertion ... failed` against the
    // native compositor.
    const monitorBars = new MonitorBars(() => {});
    monitorBars.setPills(pills);
    contentBoxOf(bars()[0]).preferredHeight = 44;
    // _resize() asks the inner content box, not the outer chrome actor, for
    // its preferred height -- real Clutter's get_stage() walks the parent
    // chain, so a child is never "in the stage" once its parent is not, but
    // this fake tracks the flag per actor rather than deriving it. Both have
    // to be set, or this test's `criticals` assertion below could not fail
    // even with the guard in _resize() deleted.
    bars()[0].inStage = false;
    contentBoxOf(bars()[0]).inStage = false;
    criticals.length = 0;

    monitorBars.setPills([{name: '9', active: true, occupied: true}]);
    monitorBars.setColors(DEFAULT_COLORS);
    monitorBars.setMode('resize');
    monitorBars.setMode(null);
    monitorBars.setVisible(false);
    monitorBars.setVisible(true);

    expect(criticals).toEqual([]);
    // The floor, not 44: with no stage to ask, _resize() never calls
    // get_preferred_height() at all, exactly as it never calls it on a
    // destroyed actor.
    expect(bars()[0].geometry.height).toBe(28);
  });

  it('records a call to an unparented bar, so the assertion above can fail', () => {
    // Same reasoning as the disposed-bar recorder above, for the other half
    // of the hazard this task closes.
    new MonitorBars(() => {});
    const actor = bars()[0];
    actor.inStage = false;

    actor.get_preferred_height(-1);

    expect(criticals).toEqual(['St.BoxLayout.get_preferred_height: not in the stage']);
    criticals.length = 0;
  });
});
