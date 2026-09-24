import {beforeEach, describe, expect, it, vi} from 'vitest';
import {log} from '../../../src/shell/log';

/**
 * What the theme would have reported, plus what the measurement did.
 *
 * The doubles model no theme at all -- no font, no padding, no scale factor --
 * so every test says for itself what St hands back, including the several ways
 * St hands back nothing useful. `vi.hoisted` because the `gi://St` factory is
 * hoisted above these declarations.
 */
const theme = vi.hoisted(() => ({
  height: 26,
  constructorThrows: false,
  tabConstructorThrows: false,
  measureThrows: false,
  /** One entry per measurement: was the row in the stage when it was measured? */
  measuredInStage: [] as boolean[],
  /** The `for_width` each measurement was asked for. */
  widths: [] as number[],
  /**
   * What the measured actor held at the moment it was measured, as
   * `kind style_class` per child. Recorded here rather than read back
   * afterwards: the row is destroyed on the way out, and Clutter's teardown
   * unparents the children with it, so a row inspected after the call looks
   * empty however it was built.
   */
  measuredChildren: [] as string[][],
}));

vi.mock('gi://St', async () => {
  const {fakeSt, uiGroup} = await import('./fakes/actors');
  return {
    default: {
      ...fakeSt,
      // The row box is what gets measured: it is the actor the engine's
      // rowHeight has to describe, padding and all.
      BoxLayout: class extends fakeSt.BoxLayout {
        constructor(props: Record<string, unknown> = {}) {
          super(props);
          if (theme.constructorThrows) throw new Error('theme unavailable');
          this.preferredHeight = theme.height;
        }

        get_preferred_height(forWidth: number): [number, number] {
          theme.measuredInStage.push(uiGroup.children.includes(this));
          theme.widths.push(forWidth);
          theme.measuredChildren.push(
            this.children.map(child => `${child.kind} ${String(child.props.style_class)}`));
          // Real St cannot answer for a widget with no theme node behind it;
          // it complains, and a caller must not assume an answer came back.
          if (theme.measureThrows) throw new Error('no theme node');
          return super.get_preferred_height(forWidth);
        }
      },
      Button: class extends fakeSt.Button {
        constructor(props: Record<string, unknown> = {}) {
          super(props);
          if (theme.tabConstructorThrows) throw new Error('no tab');
        }
      },
    },
  };
});
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {fakeSt, uiGroup, resetFakeActors, liveActors, disposedAccesses, created, lastCreated} =
  await import('./fakes/actors');

// The adapter's GNOME globals belong to the native TS program, so it is loaded
// at runtime against the doubles above rather than imported statically.
const {measureRowHeight, measureLauncherRowHeight, FALLBACK_ROW_HEIGHT} = await vi.importActual<{
  measureRowHeight(): number;
  measureLauncherRowHeight(): number;
  FALLBACK_ROW_HEIGHT: number;
}>('../../../src/shell/rowHeight');

beforeEach(() => {
  resetFakeActors();
  theme.height = 26;
  theme.constructorThrows = false;
  theme.tabConstructorThrows = false;
  theme.measureThrows = false;
  theme.measuredInStage.length = 0;
  theme.widths.length = 0;
  theme.measuredChildren.length = 0;
  vi.mocked(log.error).mockClear();
});

describe('measureRowHeight', () => {
  it("reports the themed actor's preferred height", () => {
    expect(measureRowHeight()).toBe(26);
  });

  it('measures a whole row -- a tab inside a row box -- for its natural width', () => {
    measureRowHeight();
    // What the engine reserves is the row, and what the shell sizes to that
    // number is the row box in decorations.ts, whose content is a tab button.
    // Measuring a bare label instead reports the theme's line height and
    // misses every pixel of padding either style class adds, so the tabs
    // clip by exactly the padding the stylesheet gives them.
    expect(lastCreated('row').kind).toBe('St.BoxLayout');
    expect(theme.measuredChildren).toEqual([['St.Button i3-shell-tab']]);
    expect(theme.widths).toEqual([-1]);
  });

  it('measures the row box itself, not one of its children', () => {
    measureRowHeight();
    // A row is taller than the tab in it whenever `.i3-shell-row` has padding
    // or a border of its own; only the box reports that.
    expect(theme.measuredInStage).toHaveLength(1);
    expect(lastCreated('row').preferredHeight).toBe(theme.height);
  });

  it('measures while the actor is in the stage, where St can resolve a theme node', () => {
    // St answers get_preferred_height from the widget's theme node, and a
    // widget outside the stage has none: measuring an unparented actor
    // reports the unthemed size (and complains), which is how a 24px fallback
    // would become the answer on every session regardless of the font.
    measureRowHeight();
    expect(theme.measuredInStage).toEqual([true]);
  });

  it('rounds a fractional measurement up', () => {
    // Scale factors make themed heights fractional; a row one pixel shorter
    // than its content clips the tab text it exists to show.
    theme.height = 26.4;
    expect(measureRowHeight()).toBe(27);
  });

  it('falls back when the theme reports zero', () => {
    // Review Focus: a zero measurement would silently restore the pre-3A
    // layout, with tab bars invisible and children back at the full rect.
    theme.height = 0;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    expect(FALLBACK_ROW_HEIGHT).toBe(24);
  });

  it('falls back on a negative or non-finite measurement', () => {
    theme.height = -5;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    theme.height = Number.NaN;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    theme.height = Number.POSITIVE_INFINITY;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
  });

  it('falls back when building the actor throws, without rethrowing', () => {
    theme.constructorThrows = true;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    expect(log.error).toHaveBeenCalled();
  });

  it('falls back when measuring throws, and still destroys the actor', () => {
    theme.measureThrows = true;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    // The throw is on the far side of add_child, so the label is already in
    // the stage: bailing out without destroying it would leave a stray actor
    // parented into uiGroup for the rest of the session.
    expect(liveActors()).toEqual([]);
    expect(uiGroup.children).toEqual([]);
  });

  it('falls back when building the tab throws, and leaves no row in the stage', () => {
    // The tab is built after the row box, so this is the path where the
    // cleanup has something to clean up.
    theme.tabConstructorThrows = true;
    expect(measureRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    expect(log.error).toHaveBeenCalled();
    // The row is this function's to clean up and it is gone from the stage.
    // The half-built tab is not: a constructor that throws never handed one
    // back, so there is nothing to destroy and nothing was ever parented.
    expect(lastCreated('row').destroyed).toBe(true);
    expect(uiGroup.children).toEqual([]);
  });

  it('leaves no actor behind, in the stage or out of it', () => {
    measureRowHeight();
    measureRowHeight();
    // Two actors per measurement now: the row box and the tab inside it.
    expect(created).toHaveLength(4);
    expect(liveActors()).toEqual([]);
    expect(uiGroup.children).toEqual([]);
  });

  it('touches no disposed actor', () => {
    measureRowHeight();
    theme.measureThrows = true;
    measureRowHeight();
    expect(disposedAccesses()).toEqual([]);
  });

  it('measures the launcher row against its OWN style class', () => {
    // The launcher used to size its viewport as measureRowHeight() x 10 --
    // the TITLE row's class, a different rule with different padding. The
    // moment a theme made `.i3-shell-launcher-row` the taller of the two, the
    // tenth row was clipped: the highlight vanished off the bottom of the
    // viewport and Enter launched something the user could not see.
    measureLauncherRowHeight();
    expect(lastCreated('launcher-row').kind).toBe('St.BoxLayout');
    expect(theme.measuredChildren[0].map(child => child.split(' ')[0])).toEqual(['St.Label']);
  });

  it('measures the launcher row without an icon in it', () => {
    // launcherIconSize() derives the icon from this number, so measuring with
    // an icon would make the row's height depend on its own last measurement.
    measureLauncherRowHeight();
    expect(theme.measuredChildren[0].some(child => child.startsWith('St.Icon'))).toBe(false);
  });

  it('measures the launcher row in the stage and leaves nothing behind', () => {
    expect(measureLauncherRowHeight()).toBe(26);
    expect(theme.measuredInStage).toEqual([true]);
    expect(liveActors()).toEqual([]);
    expect(uiGroup.children).toEqual([]);
  });

  it('falls back for the launcher row on the same three failures', () => {
    theme.height = 0;
    expect(measureLauncherRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    theme.height = Number.NaN;
    expect(measureLauncherRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    theme.height = 26;
    theme.measureThrows = true;
    expect(measureLauncherRowHeight()).toBe(FALLBACK_ROW_HEIGHT);
    expect(log.error).toHaveBeenCalled();
    expect(uiGroup.children).toEqual([]);
  });

  it('records a read from a disposed actor, so the assertion above is load-bearing', () => {
    // GJS does not throw on a disposed GObject, and neither do the doubles:
    // they only record. Firing the recorder here proves an empty
    // disposedAccesses() is evidence rather than an accident of the fake --
    // measuring after destroy(), the one ordering mistake this file can make,
    // would show up.
    const box = new fakeSt.BoxLayout({style_class: 'i3-shell-row'});
    box.destroy();
    box.get_preferred_height(-1);
    expect(disposedAccesses()).toEqual(['St.BoxLayout.get_preferred_height after dispose']);
  });
});
