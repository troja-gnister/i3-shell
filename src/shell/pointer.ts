import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
import type {Rect} from '../tree/node';
import {guard, type SignalTracker} from './util/signals';

export interface PointerPort {
  /** Put the pointer at the centre of `rect`. i3's `mouse_warping output`. */
  warpTo(rect: Rect): void;
}

/**
 * The pointer, for the two things the focused output needs from it.
 *
 * Crossings feed rule 4: an output whose visible workspace is empty has no window to take focus, so
 * sloppy focus can never report it and the pointer is the only evidence the user is there.
 *
 * Every pointer motion reaches this class, so the handler must stay cheap: it reads the position, maps
 * it to a monitor index, and returns immediately unless that index changed. Emptiness is the engine's
 * question and is only asked on a real crossing.
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
  private _lastMonitor: number | null = null;

  constructor(tracker: SignalTracker, onCrossed: (monitorIndex: number) => void) {
    const cursor = global.backend.get_cursor_tracker();
    tracker.connect(cursor, 'position-invalidated', guard('position-invalidated', () => {
      // CursorTracker.get_pointer() answers a Graphene.Point, not a bare [x, y] pair (unverified; see
      // the class doc comment above). It is typed nullable, but this handler only runs once the tracker
      // itself exists to have emitted the signal, so a null point here is not a case this file expects.
      const [point] = cursor.get_pointer();
      if (!point) return;
      const rect = new Mtk.Rectangle({x: Math.round(point.x), y: Math.round(point.y), width: 1, height: 1});
      const monitor = global.display.get_monitor_index_for_rect(rect);
      if (monitor === this._lastMonitor) return;
      const first = this._lastMonitor === null;
      this._lastMonitor = monitor;
      // The first report establishes where the pointer already is; it is not the user crossing.
      if (!first) onCrossed(monitor);
    }));
  }

  warpTo(rect: Rect): void {
    const seat = Clutter.get_default_backend().get_default_seat();
    seat.warp_pointer(
      Math.round(rect.x + rect.width / 2),
      Math.round(rect.y + rect.height / 2));
  }
}
