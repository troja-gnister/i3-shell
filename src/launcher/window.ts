/**
 * Which slice of the ranked list the launcher actually draws.
 *
 * This exists because `rankItems()` does not truncate and an empty query
 * matches everything: `initialState()` seeds `visible` with every installed
 * application plus every executable on `$PATH`, several thousand entries on an
 * ordinary system. A renderer that builds one actor per entry, on open and
 * again on every keystroke, while a modal grab holds the keyboard, freezes the
 * session on first use with no way out. So the renderer draws a window, and
 * this decides where the window sits.
 *
 * It lives here rather than in `session.ts` because it is not part of what a
 * keystroke means: `session.ts` reduces user intent to state and effects and
 * knows nothing about how many rows fit on screen. Keeping the two apart keeps
 * `session.ts`'s exports about actions and effects, and keeps this testable on
 * its own -- which matters, because the adapter it serves is excluded from the
 * unit suite by design.
 */

/**
 * The index of the first row to draw, given how many items there are, which
 * one is selected, and how many rows fit.
 *
 * The returned slice `[first, first + rows)` always contains `selected` and
 * never runs past `count`, which is the whole contract: a selection outside
 * the drawn slice is a cursor the user cannot see, and moving past the last
 * drawn row would look like the list had stopped responding.
 *
 * Once the list is longer than the viewport the window is centred on the
 * selection. Centring is stateless -- it needs no memory of where the window
 * was last time -- which is what lets the renderer stay a pure function of
 * state. The upper clamp keeps the last page full rather than ragged.
 */
export function firstDrawnRow(count: number, selected: number, rows: number): number {
  // A non-positive viewport draws nothing; there is no meaningful first row,
  // and returning anything else would hand the caller a negative index.
  if (rows <= 0) return 0;
  // Everything fits, so the window is the whole list and never moves.
  if (count <= rows) return 0;
  return Math.min(Math.max(0, selected - Math.floor(rows / 2)), count - rows);
}
