import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
import type {Rect} from '../tree/node';
import {guard, type SignalTracker} from './util/signals';

/** Kept identical to the inline `pointer` shape on `EnginePorts` in src/engine.ts -- see that comment. */
export interface PointerPort {
  /** Put the pointer at the centre of `rect`. i3's `mouse_warping output`. */
  warpTo(rect: Rect): void;
  /**
   * Which Mutter monitor index the pointer is on right now, or null when the compositor will not say.
   * Level-triggered: it answers whether or not the pointer has moved, which is the whole point -- see
   * the implementation and `Engine._followPointerAfterReconfigure`.
   */
  currentMonitorIndex(): number | null;
}

/**
 * The pointer, for the three things the focused output needs from it.
 *
 * Crossings feed rule 4: an output whose visible workspace is empty has no window to take focus, so
 * sloppy focus can never report it and the pointer is the only evidence the user is there.
 *
 * Every pointer motion reaches this class, so the handler must stay cheap: it reads the position, maps
 * it to a monitor index, and returns immediately unless that index changed. Emptiness is the engine's
 * question and is only asked on a real crossing.
 *
 * `currentMonitorIndex` is the same reading with the edge filter taken off, for the one moment a
 * crossing can never arrive: a hotplug changes which output the pointer is standing on without the
 * pointer moving at all, so there is nothing for `position-invalidated` to report (see the defect
 * recorded on `Engine._followPointerAfterReconfigure`).
 *
 * UNVERIFIED (see the task-12 report): every native call in this file is written from this repo's own
 * `@girs` type stubs for GNOME Shell 50 / Mutter 18 (the closest thing to ground truth available in this
 * environment -- there is no running shell here to check against), not from a live introspection dump.
 * `Meta.Rectangle` does not exist for this version -- the ambient types resolve it to `Mtk.Rectangle`,
 * so that is what `get_monitor_index_for_rect` takes here, constructed rather than passed as a plain
 * object (its parameter type is the class, not a structural shape a literal satisfies). Likewise
 * `Meta.Backend` has no seat accessor in this version's types; the seat comes from
 * `Clutter.get_default_backend().get_default_seat()` instead, which is why Clutter, not Meta, is the
 * import this file needs.
 */
export class Pointer implements PointerPort {
  /**
   * The monitor index the last *reading* -- a motion report or a `currentMonitorIndex` call -- found the
   * pointer on, and so what the next motion report is an edge against. Null means "nothing known",
   * which makes the next report a baseline rather than a crossing.
   */
  private _lastMonitor: number | null = null;
  /**
   * Captured once, because `currentMonitorIndex` and the motion handler share one reading routine and
   * the handler's per-motion cost is spec'd: going back through `global.backend.get_cursor_tracker()`
   * inside that routine would add a GJS call to every pointer motion in the session to save a field.
   */
  private readonly _cursor: ReturnType<typeof global.backend.get_cursor_tracker>;
  // Reused across every report rather than constructed fresh each time: the spec promises the
  // per-motion cost is one comparison, and `Mtk.Rectangle`'s x/y/width/height are plain writable
  // fields, so mutating this one in place is the whole difference between that and an allocation on
  // every pointer motion. `get_pointer()` and `get_monitor_index_for_rect()` are still called every
  // report -- that part of the per-motion cost is unavoidable, not overstated by this comment.
  private readonly _probe = new Mtk.Rectangle({x: 0, y: 0, width: 1, height: 1});

  constructor(tracker: SignalTracker, onCrossed: (monitorIndex: number) => void) {
    this._cursor = global.backend.get_cursor_tracker();
    tracker.connect(this._cursor, 'position-invalidated', guard('position-invalidated', () => {
      const monitor = this._read();
      if (monitor === null) return;
      if (monitor === this._lastMonitor) return;
      const first = this._lastMonitor === null;
      this._lastMonitor = monitor;
      // The first report establishes where the pointer already is; it is not the user crossing.
      if (!first) onCrossed(monitor);
    }));
  }

  /**
   * Where the pointer is now, bypassing the edge filter -- and re-seeding it with what was read.
   *
   * The re-seed lives in here rather than in a `topologyChanged()` of its own, for three reasons. It is
   * safe at any time: seeding the filter with the position the pointer is actually on can only ever
   * agree with where it is, so no reading of it can manufacture a crossing or swallow a real one.
   * A separate method would be a second call every caller has to remember, and one that forgot would
   * leave the filter comparing the user's next genuine crossing against an index belonging to a
   * configuration that no longer exists -- the hotplug reshuffles the numbers, so the stale index can
   * name a different output, or no output at all. And this reading is the only thing in the class that
   * happens at a moment the engine knows the topology has changed, so it is the only honest place for
   * it; the engine calls it on every reconfigure, including when sloppy focus is off and it will ignore
   * the answer, precisely so the filter is re-seeded there too.
   *
   * Null nulls the filter rather than leaving it: an index that could not be read is not an index the
   * next motion should be judged against, so the next report becomes a baseline again.
   */
  currentMonitorIndex(): number | null {
    const monitor = this._read();
    this._lastMonitor = monitor;
    return monitor;
  }

  /**
   * One reading: the pointer's position mapped to a monitor index, or null if the tracker gave no
   * position. Shared by the motion handler and `currentMonitorIndex` so there is one description of
   * how this project asks Mutter where the pointer is, not two that can drift.
   *
   * CursorTracker.get_pointer() answers a Graphene.Point, not a bare [x, y] pair (unverified; see the
   * class doc comment above). It is typed nullable; on the motion path the tracker has just emitted the
   * signal so a null point is not a case that path expects, and `currentMonitorIndex` is the caller
   * that gives the null a meaning.
   */
  private _read(): number | null {
    const [point] = this._cursor.get_pointer();
    if (!point) return null;
    this._probe.x = Math.round(point.x);
    this._probe.y = Math.round(point.y);
    return global.display.get_monitor_index_for_rect(this._probe);
  }

  warpTo(rect: Rect): void {
    const seat = Clutter.get_default_backend().get_default_seat();
    seat.warp_pointer(
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2));
  }
}
