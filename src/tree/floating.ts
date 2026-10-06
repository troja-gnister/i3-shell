import type {Rect} from './node';

/**
 * Where a floating window's frame belongs after its workspace moved to a different output.
 *
 * This is i3's `floating_fix_coordinates` (src/floating.c): the window's SIZE is unchanged, and the
 * centre of the window keeps the same fraction of the work area it had on the output it left. So a
 * window three quarters of the way across the laptop panel lands three quarters of the way across the
 * television, whatever the two resolutions are -- which is why this is a proportion and not the much
 * simpler "add the difference of the two origins".
 *
 * ONE DELIBERATE DIVERGENCE FROM i3: the position is clamped so the frame's top-left corner stays
 * inside `to`. i3 clamps nothing, and a window wider than the destination hangs off both sides there.
 * i3-shell's destination may be an output the user cannot see at all -- a closed lid, a sleeping
 * television -- and `move container to output primary` is documented as the rescue for exactly that
 * case; a rescue that puts the title bar above the top of the screen is not one. The SIZE is never
 * clamped: shrinking a window the user sized is a different decision, it is not i3's, and nothing here
 * would be able to restore the size afterwards.
 *
 * Total, and pure. A source work area with no extent cannot be scaled against, so the window is
 * centred on the destination instead; that is reachable only from a compositor that reports a degenerate
 * work area, and the alternative is a division by zero that would put NaN in a rect.
 */
export function fixFloatingCoordinates(rect: Rect, from: Rect, to: Rect): Rect {
  const fractionX = from.width > 0 ? (rect.x + rect.width / 2 - from.x) / from.width : 0.5;
  const fractionY = from.height > 0 ? (rect.y + rect.height / 2 - from.y) / from.height : 0.5;
  const x = Math.round(to.x + fractionX * to.width - rect.width / 2);
  const y = Math.round(to.y + fractionY * to.height - rect.height / 2);
  // Math.max on the upper bound, not just Math.min: for a window larger than the destination the far
  // edge sits BEFORE the near edge, and clamping to it would push the window off the near side -- the
  // exact failure the clamp exists to prevent.
  return {
    x: Math.min(Math.max(x, to.x), Math.max(to.x, to.x + to.width - rect.width)),
    y: Math.min(Math.max(y, to.y), Math.max(to.y, to.y + to.height - rect.height)),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Is this frame's top-left corner inside `area`? Both bounds inclusive, on both axes.
 *
 * The exact postcondition of `fixFloatingCoordinates` above, and that is the whole reason it exists:
 * `originWithin(fixFloatingCoordinates(r, from, to), to)` is true for every input, including a window
 * larger than `to` (which the clamp pins to `to`'s near edge). A caller can therefore use it to tell a
 * frame it has already translated from one it has not, and translate at most once however many times it
 * runs -- see `Engine._followFloatingFrames`, which runs on every commit and would otherwise re-translate
 * a frame it had just moved, each pass dragging it further into the destination's far corner.
 *
 * The far bounds are inclusive so that the postcondition holds with no exception to remember: a window
 * wider than `to` is pinned to `to.x`, and a zero-width one can land exactly on `to.x + to.width`.
 */
export function originWithin(rect: Rect, area: Rect): boolean {
  return rect.x >= area.x && rect.x <= area.x + area.width
    && rect.y >= area.y && rect.y <= area.y + area.height;
}
