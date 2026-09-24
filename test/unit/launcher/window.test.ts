import {describe, it, expect} from 'vitest';
import {firstDrawnRow} from '../../../src/launcher/window';

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

  it('holds the contract for a one-row viewport', () => {
    // The degenerate case the centring arithmetic is most likely to get wrong.
    for (let selected = 0; selected < 5; selected++) {
      const {first, last} = slice(5, selected, 1);
      expect(selected).toBeGreaterThanOrEqual(first);
      expect(selected).toBeLessThan(last);
    }
  });
});
