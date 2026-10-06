import type {WindowFacts, WindowInfo, WindowKind} from './model';

/**
 * i3's own classification, and the whole of what this project does with `transient`.
 *
 * `transient` makes a window FLOAT and nothing else. It does not place the window: a transient joins the
 * FOCUSED workspace like any other new window (see `Engine._adoptionWorkspace`, D7). That is i3's
 * behaviour, measured rather than assumed -- i3 4.25.1's binary uses WM_TRANSIENT_FOR for exactly two
 * things, "This window is transient for another window, setting floating" and
 * `con_find_transient_for_window`, which answers `popup_during_fullscreen smart`. There is no
 * parent-following placement rule in i3 and there is none here.
 *
 * Why that is also the right answer for this project, so the question is not re-opened: a modal dialog
 * that followed its parent onto a workspace on a display the user is not looking at would be a modal grab
 * on an invisible window -- the parent blocked, the dialog unreachable, and no obvious way back.
 *
 * Deliberately NOT carried on `WindowInfo`: a `transientFor` window id would be a new fact to keep in
 * sync with Mutter and read by nothing, since the only consumer that would want it is
 * `popup_during_fullscreen`, which is unimplemented and unbound in the user's config.
 * (Ruling: docs/superpowers/plans/2026-10-06-cleanup-and-toggle.md, Task 3.)
 */
export function classifyWindow(f: WindowFacts): WindowKind | null {
  if (f.type === 'ignored') return null;
  if (f.type !== 'normal' || f.transient || f.attached || !f.resizable)
    return 'floating';
  return 'tiled';
}

/**
 * Whether a window is currently outside the tiling tree.
 *
 * All three reasons are read every commit, never cached: `minimized` already
 * was, and `sticky`/`skipTaskbar` moved here from `WindowFacts` precisely
 * because caching them dropped a window permanently. Any one reason excludes;
 * the window rejoins only when every reason has cleared.
 *
 * `skipTaskbar` is gated on `kind === 'tiled'`, unlike the other two: before
 * the fact move, `classifyWindow` only ever reached `f.skipTaskbar` after
 * ruling out every other reason a window floats (type, transient, attached,
 * fixed-size), so a floating window never consulted it. Reading it flatly
 * here would re-widen it to floating windows too -- and Mutter genuinely
 * reports `is_skip_taskbar()` true for a modal dialog, which must keep
 * floating (and stay in the workspace's floating list), not be dropped. This
 * restores that pre-existing narrowness; it is not a new rule.
 */
export function excludedFromTree(info: WindowInfo): boolean {
  return info.minimized || info.sticky || (info.skipTaskbar && info.kind === 'tiled');
}

/**
 * What Mutter reports about a window's own size limits: the `resizeable`
 * property (its `has_resize_func`), whether the window is fullscreen -- which
 * is why that property alone will not do -- and the program min/max size
 * hints, each of which is reported only when the client actually set it:
 * `known` is the boolean returned by `get_min_size()` / `get_max_size()`.
 */
export interface SizeLimits {
  resizeable: boolean;
  fullscreen: boolean;
  minKnown: boolean;
  minWidth: number;
  minHeight: number;
  maxKnown: boolean;
  maxWidth: number;
  maxHeight: number;
}

/**
 * Whether a window can be resized at all -- an intrinsic property of the
 * window, deliberately not `Meta.Window.allows_resize()`.
 *
 * In Mutter 50.5 (src/core/window.c) that method is
 *
 *   has_resize_func && !maximized && !fullscreen &&
 *     (min_width < max_width || min_height < max_height)
 *
 * so it answers "may the user drag this border right now", and is false for a
 * window that merely happens to be maximized. Classification runs once, at
 * first frame, and is cached for the window's lifetime, so a terminal that
 * opens maximized was filed as floating forever and tiling never engaged.
 * Only the last term is intrinsic, and it is what this reproduces.
 *
 * `has_resize_func` is not purely intrinsic either: meta_window_recalc_features()
 * clears it while a window is fullscreen. For a normal, non-override-redirect
 * window it is exactly `!(min == max) && !fullscreen`, so a fullscreen window's
 * `resizeable` says nothing about the window itself and the hints are the whole
 * answer -- otherwise a player that opens fullscreen would float forever, the
 * same defect as the maximized one and against the spec's rule that a
 * fullscreen window keeps its tree slot.
 *
 * An unknown bound is an absent bound. Mutter reports an unset hint as 0 with
 * a false flag, while internally defaulting min to 0 and max to G_MAXINT, so
 * reading those zeroes as real limits would call every hintless window
 * fixed-size -- the same total failure with the opposite cause.
 */
export function isResizable(limits: SizeLimits): boolean {
  if (!limits.resizeable && !limits.fullscreen) return false;
  if (!limits.minKnown || !limits.maxKnown) return true;
  return limits.minWidth < limits.maxWidth || limits.minHeight < limits.maxHeight;
}
