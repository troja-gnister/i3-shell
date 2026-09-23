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
  measureThrows: false,
  /** One entry per measurement: was the label in the stage when it was measured? */
  measuredInStage: [] as boolean[],
  /** The `for_width` each measurement was asked for. */
  widths: [] as number[],
}));

vi.mock('gi://St', async () => {
  const {fakeSt, uiGroup} = await import('./fakes/actors');
  return {
    default: {
      ...fakeSt,
      Label: class extends fakeSt.Label {
        constructor(props: Record<string, unknown> = {}) {
          super(props);
          if (theme.constructorThrows) throw new Error('theme unavailable');
          this.preferredHeight = theme.height;
        }

        get_preferred_height(forWidth: number): [number, number] {
          theme.measuredInStage.push(uiGroup.children.includes(this));
          theme.widths.push(forWidth);
          // Real St cannot answer for a widget with no theme node behind it;
          // it complains, and a caller must not assume an answer came back.
          if (theme.measureThrows) throw new Error('no theme node');
          return super.get_preferred_height(forWidth);
        }
      },
    },
  };
});
vi.mock('resource:///org/gnome/shell/ui/main.js', async () =>
  (await import('./fakes/actors')).fakeMain);
vi.mock('../../../src/shell/log', () => ({log: {info: vi.fn(), warn: vi.fn(), error: vi.fn()}}));

const {fakeSt, uiGroup, resetFakeActors, liveActors, disposedAccesses, created} =
  await import('./fakes/actors');

// The adapter's GNOME globals belong to the native TS program, so it is loaded
// at runtime against the doubles above rather than imported statically.
const {measureRowHeight, FALLBACK_ROW_HEIGHT} = await vi.importActual<{
  measureRowHeight(): number;
  FALLBACK_ROW_HEIGHT: number;
}>('../../../src/shell/rowHeight');

beforeEach(() => {
  resetFakeActors();
  theme.height = 26;
  theme.constructorThrows = false;
  theme.measureThrows = false;
  theme.measuredInStage.length = 0;
  theme.widths.length = 0;
  vi.mocked(log.error).mockClear();
});

describe('measureRowHeight', () => {
  it("reports the themed actor's preferred height", () => {
    expect(measureRowHeight()).toBe(26);
  });

  it('measures a tab-styled actor, for its natural width', () => {
    measureRowHeight();
    // The row exists to hold tabs, so it is a tab that has to fit in it: any
    // other style class measures padding and a font the tabs do not use.
    expect(created.at(-1)!.props.style_class).toBe('i3-shell-tab');
    expect(theme.widths).toEqual([-1]);
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

  it('leaves no actor behind, in the stage or out of it', () => {
    measureRowHeight();
    measureRowHeight();
    expect(created).toHaveLength(2);
    expect(liveActors()).toEqual([]);
    expect(uiGroup.children).toEqual([]);
  });

  it('touches no disposed actor', () => {
    measureRowHeight();
    theme.measureThrows = true;
    measureRowHeight();
    expect(disposedAccesses()).toEqual([]);
  });

  it('records a read from a disposed actor, so the assertion above is load-bearing', () => {
    // GJS does not throw on a disposed GObject, and neither do the doubles:
    // they only record. Firing the recorder here proves an empty
    // disposedAccesses() is evidence rather than an accident of the fake --
    // measuring after destroy(), the one ordering mistake this file can make,
    // would show up.
    const label = new fakeSt.Label({style_class: 'i3-shell-tab'});
    label.destroy();
    label.get_preferred_height(-1);
    expect(disposedAccesses()).toEqual(['St.Label.get_preferred_height after dispose']);
  });
});
