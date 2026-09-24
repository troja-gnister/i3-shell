import {describe, it, expect} from 'vitest';
import fc from 'fast-check';
import {
  CHROME_ROWS, firstDrawnRow, launcherBox, launcherIconSize, launcherWidth, visibleRowCount,
} from '../../../src/launcher/window';

const ROWS = 10;

/** The contract, asserted the same way for every case below. */
const slice = (count: number, selected: number, rows = ROWS): {first: number; last: number} => {
  const first = firstDrawnRow(count, selected, rows);
  return {first, last: Math.min(first + rows, count)};
};

describe('firstDrawnRow', () => {
  describe('count <= rows: the whole list fits, so the window never moves', () => {
    const cases: Array<[number, number]> = [[0, 0], [1, 0], [5, 0], [5, 4], [10, 0], [10, 9]];
    for (const [count, selected] of cases) {
      it(`draws from 0 for ${count} item(s) with ${selected} selected`, () => {
        expect(firstDrawnRow(count, selected, ROWS)).toBe(0);
      });
    }
  });

  describe('selected near the head: the window stays pinned to the top', () => {
    const cases: Array<[number, number]> = [[100, 0], [100, 1], [100, 4], [100, 5]];
    for (const [count, selected] of cases) {
      it(`draws from 0 with ${selected} selected of ${count}`, () => {
        expect(firstDrawnRow(count, selected, ROWS)).toBe(0);
      });
    }
  });

  describe('selected in the middle: the window centres on the selection', () => {
    const cases: Array<[number, number, number]> = [[100, 6, 1], [100, 10, 5], [100, 50, 45], [100, 94, 89]];
    for (const [count, selected, expected] of cases) {
      it(`draws from ${expected} with ${selected} selected of ${count}`, () => {
        expect(firstDrawnRow(count, selected, ROWS)).toBe(expected);
      });
    }
  });

  describe('selected at the tail: the last page is full, not ragged', () => {
    const cases: Array<[number, number]> = [[100, 95], [100, 98], [100, 99]];
    for (const [count, selected] of cases) {
      it(`draws from 90 with ${selected} selected of ${count}`, () => {
        expect(firstDrawnRow(count, selected, ROWS)).toBe(90);
        expect(firstDrawnRow(count, selected, ROWS) + ROWS).toBe(count);
      });
    }
  });

  it('never draws a negative first row', () => {
    for (let count = 0; count <= 40; count++)
      for (let selected = 0; selected < Math.max(1, count); selected++)
        expect(firstDrawnRow(count, selected, ROWS)).toBeGreaterThanOrEqual(0);
  });

  it('always draws a slice that contains the selection', () => {
    // The whole point of the window: a selection outside it is a cursor the
    // user cannot see, and arrowing past the last drawn row would look like
    // the list had stopped responding.
    for (let count = 1; count <= 60; count++) {
      for (let selected = 0; selected < count; selected++) {
        const {first, last} = slice(count, selected);
        expect(selected).toBeGreaterThanOrEqual(first);
        expect(selected).toBeLessThan(last);
      }
    }
  });

  it('never runs the slice past the end of the list', () => {
    for (let count = 0; count <= 60; count++) {
      for (let selected = 0; selected < Math.max(1, count); selected++) {
        const first = firstDrawnRow(count, selected, ROWS);
        expect(first + ROWS).toBeLessThanOrEqual(Math.max(count, ROWS));
        expect(first).toBeLessThanOrEqual(Math.max(0, count - 1));
      }
    }
  });

  it('draws nothing from row 0 for an empty list', () => {
    // initialState() on a catalogue that failed to build, or a query that
    // matches nothing: there is no selection to centre on.
    expect(firstDrawnRow(0, 0, ROWS)).toBe(0);
  });

  it('returns 0 for a non-positive viewport rather than a negative index', () => {
    expect(firstDrawnRow(100, 50, 0)).toBe(0);
    expect(firstDrawnRow(100, 50, -1)).toBe(0);
  });

  it('contains the selection only when the window and the slice agree on the row count', () => {
    // Why src/shell/launcher.ts must pass ONE row count to both halves of its
    // slice. `slice()` above uses the same `rows` twice, which is the contract;
    // this is what the contract costs when a caller breaks it.
    //
    // A viewport holding 4 rows, a 500-item list, the selection on row 9:
    const first = firstDrawnRow(500, 9, 4);
    expect(first).toBe(7);                       // window [7, 11) -- contains 9
    expect(9).toBeGreaterThanOrEqual(first);
    expect(9).toBeLessThan(first + 4);

    // The same call asked for a DIFFERENT number of rows -- what an adapter
    // does when one of its two uses of the row count is stale:
    const wrong = firstDrawnRow(500, 9, 10);
    expect(wrong).toBe(4);                       // window [4, 8) -- does NOT
    expect(9).toBeGreaterThanOrEqual(wrong + 4);
    // Four rows are still drawn, so every count assertion still passes. The
    // selected row is simply not one of them.
  });

  it('contains the selection for every row count, swept, not just for ten', () => {
    // The existing sweeps above all fix `rows` at ROWS. A work area that holds
    // fewer rows than VISIBLE_ROWS is the ordinary case on a short output, and
    // it is where the centring arithmetic is most likely to drift.
    for (const rows of [1, 2, 3, 4, 5, 7, 9, 10, 13]) {
      for (const count of [1, 2, 5, 11, 60, 500]) {
        for (const selected of [0, 1, Math.floor(count / 2), count - 2, count - 1]) {
          if (selected < 0 || selected >= count) continue;
          const first = firstDrawnRow(count, selected, rows);
          const last = Math.min(first + rows, count);
          expect(selected, `rows ${rows}, count ${count}, selected ${selected}`)
            .toBeGreaterThanOrEqual(first);
          expect(selected, `rows ${rows}, count ${count}, selected ${selected}`)
            .toBeLessThan(last);
        }
      }
    }
  });

  it('holds the contract for a one-row viewport', () => {
    // The degenerate case the centring arithmetic is most likely to get wrong.
    for (let selected = 0; selected < 5; selected++) {
      const {first, last} = slice(5, selected, 1);
      expect(selected).toBeGreaterThanOrEqual(first);
      expect(selected).toBeLessThan(last);
    }
  });
});

describe('launcherWidth', () => {
  it('takes the configured fraction of an ordinary work area', () => {
    expect(launcherWidth(1920)).toBe(806);   // 0.42 * 1920
    expect(launcherWidth(1728)).toBe(726);
  });

  it('is clamped up to the readable minimum on a narrow-but-not-tiny area', () => {
    expect(launcherWidth(800)).toBe(360);    // 0.42 * 800 = 336
  });

  it('is clamped down on a very wide area', () => {
    expect(launcherWidth(5120)).toBe(900);
  });

  it('never beats the work area itself', () => {
    // The defect: MIN_WIDTH used to win outright, so a 320px-wide output got a
    // 360px box, the centring subtraction went negative, and the launcher hung
    // off the monitor's left edge -- a variant of the very bug this feature
    // exists to fix.
    expect(launcherWidth(320)).toBe(320);
    expect(launcherWidth(100)).toBe(100);
    expect(launcherWidth(0)).toBe(0);
  });
});

/**
 * A measured chrome, as `measureLauncherChrome()` would report it for a 26px
 * row at Cantarell 11: `.i3-shell-launcher`'s 6px padding and 1px border on
 * both sides (14), `.i3-shell-launcher-entry`'s 6px bottom margin, and the
 * entry itself at a 20px line height plus GNOME's own 9px StEntry padding on
 * both sides (38). Deliberately NOT a multiple of 26 -- the whole point is
 * that the chrome and the rows are sized by different stylesheet rules.
 */
const CHROME = 58;

describe('visibleRowCount', () => {
  it('gives the full ten rows on an ordinary work area', () => {
    expect(visibleRowCount(1048, 26, 10, CHROME)).toBe(10);
  });

  it('never exceeds the rows asked for', () => {
    expect(visibleRowCount(4000, 26, 10, CHROME)).toBe(10);
  });

  it('reduces the rows when the work area cannot hold them', () => {
    // 300px high, 12% (36) above the box, 58 of chrome: 206 left, five 40px rows.
    expect(visibleRowCount(300, 40, 10, CHROME)).toBe(5);
  });

  it('is zero when not even the chrome fits', () => {
    expect(visibleRowCount(60, 40, 10, CHROME)).toBe(0);
    expect(visibleRowCount(0, 26, 10, CHROME)).toBe(0);
  });

  it('is zero for a degenerate row height or row count', () => {
    expect(visibleRowCount(1048, 0, 10, CHROME)).toBe(0);
    expect(visibleRowCount(1048, -5, 10, CHROME)).toBe(0);
    expect(visibleRowCount(1048, 26, 0, CHROME)).toBe(0);
  });

  it('reserves the chrome it was given, not a multiple of the row height', () => {
    // A tall chrome costs rows; a short one buys them. Counting the chrome in
    // row heights cannot express either.
    expect(visibleRowCount(400, 26, 10, 20)).toBeGreaterThan(visibleRowCount(400, 26, 10, 200));
  });
});

describe('launcherBox', () => {
  const AREA = {x: 1728, y: 27, width: 1920, height: 1053};

  it('centres the box horizontally in the work area it was given', () => {
    const box = launcherBox(AREA, 26, 10, CHROME);
    expect(box.width).toBe(806);
    expect(box.x).toBe(1728 + Math.round((1920 - 806) / 2));
  });

  it('places the top edge an eighth of the way down', () => {
    const box = launcherBox(AREA, 26, 10, CHROME);
    expect(box.y).toBe(27 + Math.round(1053 * 0.12));
  });

  it('is offset by the work area origin, not the screen origin', () => {
    // The whole feature: the box belongs to the monitor holding focus, and a
    // second monitor's work area does not start at 0,0.
    const primary = launcherBox({x: 0, y: 27, width: 1920, height: 1053}, 26, 10, CHROME);
    const second = launcherBox(AREA, 26, 10, CHROME);
    expect(second.x - primary.x).toBe(1728);
    expect(second.y).toBe(primary.y);
  });

  it('is exactly the sum of its parts: the measured chrome plus the drawn rows', () => {
    // The regression this replaces: the height was `rowHeight * (drawn + 2)`,
    // which is about eleven pixels SHORT of the contents at Cantarell 11,
    // because `.i3-shell-launcher-row` has 2px of padding and GNOME's StEntry
    // has 9px. A box forced shorter than its contents overflows its own plate,
    // and in the bottom-clamped branch it overflows the work area.
    expect(launcherBox(AREA, 26, 10, CHROME).height).toBe(CHROME + 26 * 10);
  });

  it('follows the chrome the theme reported rather than a row multiple', () => {
    const tall = launcherBox(AREA, 26, 10, 120);
    const short = launcherBox(AREA, 26, 10, 20);
    // Both still draw ten rows on an area this size, so the whole difference
    // is the chrome -- and it is carried through exactly.
    expect(tall.height - short.height).toBe(100);
  });

  it('falls back to three row heights, never two, when nothing could be measured', () => {
    // CHROME_ROWS is only reachable through measureLauncherChrome()'s failure
    // path; two rows was the value that was short.
    expect(CHROME_ROWS).toBe(3);
    expect(launcherBox(AREA, 26, 10, 26 * CHROME_ROWS).height).toBe(26 * (10 + 3));
  });

  it('shrinks rather than overflowing a short work area', () => {
    const box = launcherBox({x: 0, y: 0, width: 1920, height: 300}, 40, 10, CHROME);
    expect(box.height).toBe(CHROME + 40 * 5);
    expect(box.y + box.height).toBeLessThanOrEqual(300);
  });

  it('pulls the box up rather than off the bottom edge', () => {
    // Nothing clamped the bottom before: a box taller than the space below
    // TOP_FRACTION simply ran off the work area.
    const area = {x: 0, y: 0, width: 1920, height: 200};
    const box = launcherBox(area, 60, 10, CHROME);
    expect(box.y + box.height).toBeLessThanOrEqual(area.height);
  });

  it('stays inside a work area narrower than the minimum width', () => {
    const area = {x: 0, y: 0, width: 320, height: 800};
    const box = launcherBox(area, 26, 10, CHROME);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
  });

  it('always returns a rect inside the work area', () => {
    // The contract, swept rather than sampled: every combination below is a
    // work area some real or virtual output could hand us, including the
    // degenerate ones a monitor change produces mid-flight.
    const origins = [{x: 0, y: 0}, {x: 1728, y: 27}, {x: -1920, y: -1080}];
    const sizes = [0, 1, 100, 320, 360, 640, 800, 1280, 1920, 3840, 5120];
    const heights = [0, 1, 60, 200, 300, 768, 1048, 1440, 2160];
    const rowHeights = [0, 1, 8, 24, 26, 40, 60, 120];
    for (const origin of origins)
      for (const width of sizes)
        for (const height of heights)
          for (const rowHeight of rowHeights) {
            const area = {...origin, width, height};
            const box = launcherBox(area, rowHeight, 10, CHROME);
            expect(box.width).toBeGreaterThanOrEqual(0);
            expect(box.height).toBeGreaterThanOrEqual(0);
            expect(box.x).toBeGreaterThanOrEqual(area.x);
            expect(box.y).toBeGreaterThanOrEqual(area.y);
            expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width);
            expect(box.y + box.height).toBeLessThanOrEqual(area.y + area.height);
          }
  });

  it('holds containment for arbitrary areas, row heights and chromes', () => {
    fc.assert(fc.property(
      fc.integer({min: -4000, max: 4000}),
      fc.integer({min: -4000, max: 4000}),
      fc.integer({min: 0, max: 6000}),
      fc.integer({min: 0, max: 4000}),
      fc.integer({min: 0, max: 200}),
      fc.integer({min: 0, max: 40}),
      fc.integer({min: 0, max: 400}),
      (x, y, width, height, rowHeight, rows, chrome) => {
        const area = {x, y, width, height};
        const box = launcherBox(area, rowHeight, rows, chrome);
        return box.x >= area.x
          && box.y >= area.y
          && box.width >= 0
          && box.height >= 0
          && box.x + box.width <= area.x + area.width
          && box.y + box.height <= area.y + area.height;
      }), {numRuns: 2000});
  });

  it('always reserves room for every row it says to draw', () => {
    // The two have to agree: a viewport shorter than the rows the renderer
    // builds clips the last one, and the selection can be on it.
    fc.assert(fc.property(
      fc.integer({min: 0, max: 4000}),
      fc.integer({min: 1, max: 200}),
      fc.integer({min: 0, max: 40}),
      fc.integer({min: 0, max: 400}),
      (height, rowHeight, rows, chrome) => {
        const area = {x: 0, y: 0, width: 1920, height};
        const drawn = visibleRowCount(height, rowHeight, rows, chrome);
        return launcherBox(area, rowHeight, rows, chrome).height >= drawn * rowHeight;
      }), {numRuns: 1000});
  });
});

describe('launcherIconSize', () => {
  it('follows the measured row height', () => {
    expect(launcherIconSize(24)).toBe(17);
    expect(launcherIconSize(40)).toBe(28);
    expect(launcherIconSize(60)).toBe(42);
  });

  it('is not the hardcoded 16 that spec 5 forbids', () => {
    expect(launcherIconSize(48)).not.toBe(16);
  });

  it('never goes below a visible minimum', () => {
    expect(launcherIconSize(0)).toBe(8);
    expect(launcherIconSize(-10)).toBe(8);
  });

  it('always leaves the row taller than its icon', () => {
    // Otherwise the icon drives the row height, and the measurement that
    // produced the icon size was wrong the moment it was used.
    for (let rowHeight = 16; rowHeight <= 200; rowHeight++)
      expect(launcherIconSize(rowHeight)).toBeLessThan(rowHeight);
  });
});
