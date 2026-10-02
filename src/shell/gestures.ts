import Clutter from 'gi://Clutter';
import {guard, type SignalTracker} from './util/signals';

/** Which way the user's fingers travelled. `bindgesture swipe:left` / `swipe:right`. */
export type SwipeDirection = 'left' | 'right';

/**
 * How far the fingers must travel horizontally, in stage pixels, before a swipe counts.
 *
 * Three fingers resting on a touchpad drift tens of pixels without the user meaning anything by it, and
 * a workspace switch is not a cheap mistake to make. Deliberately a flat number rather than a fraction
 * of the monitor width: the gesture is a hand movement on a touchpad, and the touchpad does not get
 * bigger when a larger display is plugged in.
 */
const SWIPE_THRESHOLD = 100;

/**
 * Three-finger horizontal touchpad swipes, as `bindgesture` directions.
 *
 * Accumulates `get_gesture_motion_delta()` across one BEGIN -> UPDATE* -> END sequence and reports a
 * direction on END when the horizontal travel both passed `SWIPE_THRESHOLD` and dominated the vertical
 * travel. CANCEL discards the accumulation; so does a sequence whose BEGIN this class never saw, since
 * there is no travel it can vouch for. Only three-finger gestures are examined -- GNOME's own four-finger
 * gestures, and its vertical three-finger swipe to the overview, are left exactly as they were, which is
 * also why the vertical-dominance test is there and not just a bare threshold.
 *
 * Every event on the stage reaches this handler, so the type check comes first and returns before
 * anything else is asked of the event.
 *
 * It claims nothing: the handler always answers `Clutter.EVENT_PROPAGATE`. GNOME's own workspace swipe
 * lives on `Main.wm._workspaceAnimation._swipeTracker`, a private that is typed `any` and breaks across
 * Shell versions; this design deliberately does not touch it, and competing with it for the event would
 * mean reasoning about a capture order nothing here can verify. GNOME's half is already covered: with the
 * extension enabled there are exactly two native workspaces, and `Engine.onWorkspacesChanged` puts the
 * active one back on LIVE when GNOME's gesture moves it.
 *
 * UNVERIFIED, in `src/shell/pointer.ts`'s sense: every native call here is written from this repo's own
 * `@girs/clutter-18` stubs for GNOME Shell 50 / Mutter 18, not from a live introspection dump -- there is
 * no running shell in this environment to check against. Each one was read in those stubs:
 * `Clutter.EventType.TOUCHPAD_SWIPE`, `Clutter.TouchpadGesturePhase.{BEGIN,UPDATE,END,CANCEL}`,
 * `Event.type()`, `Event.get_gesture_phase()`, `Event.get_gesture_motion_delta()` (which answers a
 * `[dx, dy]` pair, not an out-parameter), `Event.get_touchpad_gesture_finger_count()`, `Event.get_time()`
 * and `Clutter.EVENT_PROPAGATE`. The recogniser is unit-tested only for a reason that is not going to
 * change: the nested-shell harness cannot synthesise touchpad events, so no native scenario can drive
 * this class. `org.i3shell.Debug.SimulateSwipe` covers the engine side of the path instead.
 */
export class Gestures {
  private _dx = 0;
  private _dy = 0;
  /**
   * Whether a BEGIN this class saw is still open.
   *
   * It is the gate on END, not on UPDATE: an UPDATE this class cannot account for still accumulates, and
   * the next BEGIN zeroes whatever it left behind. Gating UPDATE as well would make the END gate
   * unobservable -- a guard whose removal changes no behaviour is a guard no test can prove.
   */
  private _tracking = false;

  constructor(tracker: SignalTracker, onSwipe: (direction: SwipeDirection, timestamp: number) => void) {
    tracker.connect(global.stage, 'captured-event', guard('captured-event', (event: Clutter.Event) => {
      if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE) return Clutter.EVENT_PROPAGATE;
      // Before the phase, not after: a count this class does not claim must leave no trace in the
      // accumulator at all, or a four-finger swipe's BEGIN would reset a three-finger one mid-flight.
      if (event.get_touchpad_gesture_finger_count() !== 3) return Clutter.EVENT_PROPAGATE;
      switch (event.get_gesture_phase()) {
        case Clutter.TouchpadGesturePhase.BEGIN:
          // The one place the accumulator is cleared. Doing it here rather than when a gesture finishes
          // is what keeps a dropped END or CANCEL from leaking one gesture's travel into the next.
          this._dx = 0;
          this._dy = 0;
          this._tracking = true;
          break;
        case Clutter.TouchpadGesturePhase.UPDATE: {
          const [dx, dy] = event.get_gesture_motion_delta();
          this._dx += dx;
          this._dy += dy;
          break;
        }
        case Clutter.TouchpadGesturePhase.END: {
          if (!this._tracking) break;
          this._tracking = false;
          // END carries a delta of its own, so it is added rather than ignored.
          const [dx, dy] = event.get_gesture_motion_delta();
          const totalX = this._dx + dx;
          const totalY = this._dy + dy;
          if (Math.abs(totalX) >= SWIPE_THRESHOLD && Math.abs(totalX) > Math.abs(totalY))
            onSwipe(totalX < 0 ? 'left' : 'right', event.get_time());
          break;
        }
        case Clutter.TouchpadGesturePhase.CANCEL:
          // Closing `_tracking` IS the discard: the travel itself stays in the accumulator until the next
          // BEGIN zeroes it, and with no open gesture there is nothing an END could complete.
          this._tracking = false;
          break;
      }
      return Clutter.EVENT_PROPAGATE;
    }));
  }
}
