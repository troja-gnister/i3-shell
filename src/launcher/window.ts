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
 * `session.ts`'s exports about actions and effects, and lets the arithmetic be
 * property-tested without a compositor -- which is what spec 2.2 means by "the
 * adapter draws where it is told and makes no placement decision".
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

/**
 * How wide the box is, how tall, and where its top-left corner goes.
 *
 * Every number below used to live in `src/shell/launcher.ts` as four private
 * constants and two `set_position` arguments, which put a placement decision in
 * an adapter that spec 2.2 says "draws where it is told and makes no placement
 * decision" -- and left it untested. It also had a real defect: `MIN_WIDTH` beat
 * any work area narrower than 360px, and the centring subtraction then went
 * negative, so the box hung off the monitor's left edge. That is a variant of
 * the very bug this feature exists to fix, so the clamp below is against the
 * work area first and the preferred bounds second. Nothing clamped the bottom
 * at all, which is why there is a height here now rather than a box left to
 * size itself from its children.
 *
 * The contract, property-tested in test/unit/launcher/window.test.ts across a
 * sweep of areas and row heights: the returned rect always lies inside `area`.
 */
const WIDTH_FRACTION = 0.42;
const MIN_WIDTH = 360;
const MAX_WIDTH = 900;
/** How far down the work area the box's top edge sits, before the bottom clamp. */
const TOP_FRACTION = 0.12;
/**
 * The part of the box that is not list rows -- the search entry, the entry's
 * bottom margin, and the box's own padding and border -- counted in row
 * heights rather than pixels so it follows the font and the scale factor
 * exactly as the rows do. Two rows covers `.i3-shell-launcher`'s 6px padding
 * plus 1px border, `.i3-shell-launcher-entry`'s 6px margin, and the entry
 * itself, at every row height a theme realistically produces.
 */
export const CHROME_ROWS = 2;

/** `value`, clamped into [`low`, `high`]; `low` wins if the range is inverted. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The box's width for a work area of `areaWidth`.
 *
 * The work area is the outer clamp, not the inner one: a 320px-wide output is
 * unusual but a box wider than its screen is always wrong, and the minimum is a
 * readability preference, not a guarantee.
 */
export function launcherWidth(areaWidth: number): number {
  const area = Math.max(0, areaWidth);
  return Math.min(area, clamp(Math.round(area * WIDTH_FRACTION), MIN_WIDTH, MAX_WIDTH));
}

/**
 * How many list rows actually fit, given the top offset and the chrome, capped
 * at the `rows` the caller wants drawn.
 *
 * The renderer and the viewport both read this, so the number of rows built and
 * the height reserved for them cannot disagree -- which is what would clip the
 * last row and hide the selection on it.
 */
export function visibleRowCount(areaHeight: number, rowHeight: number, rows: number): number {
  if (rowHeight <= 0 || rows <= 0) return 0;
  const height = Math.max(0, areaHeight);
  const forRows = height - Math.round(height * TOP_FRACTION) - rowHeight * CHROME_ROWS;
  if (forRows <= 0) return 0;
  return Math.min(rows, Math.floor(forRows / rowHeight));
}

export function launcherBox(
  area: {x: number; y: number; width: number; height: number},
  rowHeight: number,
  rows: number,
): {x: number; y: number; width: number; height: number} {
  const areaWidth = Math.max(0, area.width);
  const areaHeight = Math.max(0, area.height);
  const width = launcherWidth(areaWidth);
  const drawn = visibleRowCount(areaHeight, rowHeight, rows);
  const height = Math.min(areaHeight, Math.max(0, rowHeight) * (drawn + CHROME_ROWS));
  return {
    x: area.x + Math.max(0, Math.round((areaWidth - width) / 2)),
    // The bottom clamp: a box taller than the space below TOP_FRACTION is
    // pulled up rather than allowed to run off the work area's bottom edge.
    y: area.y + clamp(Math.round(areaHeight * TOP_FRACTION), 0, areaHeight - height),
    width,
    height,
  };
}

/**
 * Spec 5: the icon is sized from the measured row, never from a constant. A
 * fixed 16px icon is half the height of a row on a HiDPI or large-font session
 * and looks like a rendering fault rather than a choice.
 *
 * The factor is below 1 by more than `.i3-shell-launcher-row`'s vertical
 * padding, so the icon never becomes what drives the row's height -- which
 * would make the measurement that produced it wrong on the next open.
 */
export function launcherIconSize(rowHeight: number): number {
  return Math.max(8, Math.round(Math.max(0, rowHeight) * 0.7));
}
