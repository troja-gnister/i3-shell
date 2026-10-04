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
 * The handler takes `(actor, event)`, not `(event)`: a GJS signal callback receives the emitting object
 * ahead of the signal's own arguments, as `src/shell/keys.ts`'s `accelerator-activated` handler
 * (`(_display, action, _device, timestamp)`) shows. `@girs` lists `captured-event` as `(event: Event) =>
 * boolean | void` -- its `SignalSignatures` entries carry the signal's own arguments only -- and
 * `SignalTracker.connect` accepts `(...args: any[])`, so neither the stubs nor the typechecker can catch
 * getting this wrong. Fix round 1, B1: it WAS wrong, and the Stage arriving where the event was expected
 * threw on `.type()` for every event in the session until the native run found it.
 *
 * It CLAIMS the gestures it recognises: a three-finger `TOUCHPAD_SWIPE` answers `Clutter.EVENT_STOP` in
 * every phase, so GNOME never sees any part of it. With this extension enabled GNOME has exactly two
 * workspaces, so its own swipe animates toward the ATTIC -- which is where parked windows live -- and
 * `Engine.onWorkspacesChanged`'s guard then corrects the active workspace back to LIVE. Letting both run
 * risks a visible flash of another workspace's windows on every swipe, plus one guard correction per swipe
 * in the journal. That guard exists precisely to swallow these gestures, and preventing GNOME from acting
 * is strictly better than undoing it afterwards. Every phase and not only END, because a claimed END
 * after a propagated BEGIN would still have let GNOME start animating. Nothing else is shadowed: a
 * non-swipe event and a swipe with any other finger count both answer `Clutter.EVENT_PROPAGATE`, and
 * `Main.wm._workspaceAnimation._swipeTracker` -- a private, typed `any`, that breaks across Shell
 * versions -- is still never touched.
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
    tracker.connect(global.stage, 'captured-event',
      guard('captured-event', (_actor: Clutter.Actor, event: Clutter.Event) => {
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
        // EVENT_STOP, and for every phase that got this far: this is a three-finger touchpad swipe,
        // which this extension owns outright. See the class comment for why claiming beats correcting.
        return Clutter.EVENT_STOP;
      }));
  }
}
