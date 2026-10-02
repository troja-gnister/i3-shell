import {afterEach, describe, expect, it, vi} from 'vitest';
import {SignalTracker} from '../../../src/shell/util/signals';

// Only the four members `gestures.ts` actually reads. The numeric values are the real ones from this
// repo's `@girs/clutter-18` stubs (EventType.TOUCHPAD_SWIPE = 14, TouchpadGesturePhase BEGIN/UPDATE/
// END/CANCEL = 0/1/2/3) so the fake cannot pass a gesture the real enum would have sorted differently.
vi.mock('gi://Clutter', () => ({
  default: {
    EVENT_PROPAGATE: false,
    EVENT_STOP: true,
    EventType: {TOUCHPAD_SWIPE: 14, MOTION: 7, SCROLL: 10},
    TouchpadGesturePhase: {BEGIN: 0, UPDATE: 1, END: 2, CANCEL: 3},
  },
}));

// Typed inline rather than statically imported, for the reason pointer.test.ts gives: gestures.ts reads
// `global.stage` at construction, which only typechecks under the native program's ambient `@girs` types.
const {Gestures} = await vi.importActual<{
  Gestures: new (tracker: SignalTracker, onSwipe: (direction: 'left' | 'right', timestamp: number) => void) => object;
}>('../../../src/shell/gestures');

interface FakeEvent {
  type(): number;
  get_gesture_phase(): number;
  get_gesture_motion_delta(): [number, number];
  get_touchpad_gesture_finger_count(): number;
  get_time(): number;
}

/**
 * Wires a real `Gestures` against a fake stage, and plays events at it the way Mutter would: one BEGIN,
 * then any number of UPDATEs each carrying its own small delta, then END or CANCEL.
 *
 * **The handler is invoked with two arguments, actor first**, because that is what GJS really does: a
 * signal callback receives the emitting object ahead of the signal's own arguments. (`@girs`'s
 * `SignalSignatures` entry for `captured-event` reads `(event: Event) => boolean | void` and lists only
 * the signal's own argument -- girs prepends the instance in its own `connect` overloads -- and
 * `SignalTracker.connect` takes `(...args: any[])`, so nothing typechecked this either way. This repo's
 * witness for the real shape is `src/shell/keys.ts`, whose `accelerator-activated` handler is
 * `(_display, action, _device, timestamp)`.) Fix round 1, B1: this fake used to pass the event alone,
 * which reproduced the production mistake instead of catching it, and the Stage arriving where the event
 * was expected threw on `.type()` on every single event in a real session.
 *
 * `fakeStage` is deliberately a bare object with no `type()` on it, exactly like the real `Clutter.Stage`:
 * a handler that reads the first argument as the event gets a TypeError, which is the production failure.
 */
function gestureHarness() {
  let handler: ((actor: object, event: FakeEvent) => boolean | void) | null = null;
  let nextId = 1;
  const fakeStage = {
    connect: (signal: string, callback: (actor: object, event: FakeEvent) => boolean | void) => {
      if (signal === 'captured-event') handler = callback;
      return nextId++;
    },
    disconnect: () => { handler = null; },
  };
  vi.stubGlobal('stage', fakeStage);
  const tracker = new SignalTracker();
  const swipes: Array<{direction: string; timestamp: number}> = [];
  new Gestures(tracker, (direction, timestamp) => { swipes.push({direction, timestamp}); });
  const send = (
    phase: number, dx: number, dy: number, fingers = 3, type = 14, time = 100,
  ): boolean | void => handler?.(fakeStage, {
    type: () => type,
    get_gesture_phase: () => phase,
    get_gesture_motion_delta: () => [dx, dy],
    get_touchpad_gesture_finger_count: () => fingers,
    get_time: () => time,
  });
  return {
    tracker, send, swipes,
    /** BEGIN, three equal UPDATEs totalling (dx, dy), then END. Answers what each phase returned. */
    swipe(dx: number, dy: number, fingers = 3, time = 100): Array<boolean | void> {
      const answers = [send(0, 0, 0, fingers, 14, time)];
      for (let i = 0; i < 3; i++) answers.push(send(1, dx / 3, dy / 3, fingers, 14, time));
      answers.push(send(2, 0, 0, fingers, 14, time));
      return answers;
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('Gestures', () => {
  it('reports left for a three-finger swipe whose fingers travelled left, and claims every phase', () => {
    const h = gestureHarness();
    const answers = h.swipe(-300, 0, 3, 4242);
    expect(h.swipes).toEqual([{direction: 'left', timestamp: 4242}]);
    // EVENT_STOP (true in the fake Clutter above) for BEGIN, three UPDATEs and END alike -- see the
    // claim test below for why every phase and not only the one that reports.
    expect(answers).toEqual([true, true, true, true, true]);
  });

  it('reports right for the opposite travel, and claims every phase of that one too', () => {
    const h = gestureHarness();
    const answers = h.swipe(300, 0);
    expect(h.swipes).toEqual([{direction: 'right', timestamp: 100}]);
    expect(answers).toEqual([true, true, true, true, true]);
  });

  it('reports nothing when the horizontal travel never passes the threshold', () => {
    // A 30px drift is a hand resting on the pad, not a swipe. Reported, it would switch workspaces
    // every time the user moved three fingers at all.
    const h = gestureHarness();
    h.swipe(-30, 0);
    expect(h.swipes).toEqual([]);
  });

  it('reports nothing when the gesture is mostly vertical', () => {
    // Far past the horizontal threshold, but the user swiped down-and-slightly-left: GNOME owns the
    // vertical swipe (the overview), and claiming this one would fire a workspace switch on the way there.
    const h = gestureHarness();
    h.swipe(-300, 900);
    expect(h.swipes).toEqual([]);
  });

  it('reports nothing for a gesture cancelled after passing the threshold, even if an END follows', () => {
    // The END is what makes this test mean anything. Without it the assertion would hold whether or not
    // CANCEL did anything at all -- there would be no phase left that could report -- which is the shape
    // of a test that cannot fail. CANCEL's job is to make the open gesture uncompletable, so completing
    // it is what has to be tried.
    const h = gestureHarness();
    h.send(0, 0, 0);
    h.send(1, -300, 0);
    h.send(3, 0, 0); // CANCEL
    h.send(2, 0, 0); // END, which must now find nothing open
    expect(h.swipes).toEqual([]);
  });

  it('starts each gesture from zero, so one swipe cannot be finished by the next', () => {
    // 300 left then 200 right: carried travel would total 100 left and report a second 'left'.
    const h = gestureHarness();
    h.swipe(-300, 0);
    h.swipe(200, 0);
    expect(h.swipes).toEqual([{direction: 'left', timestamp: 100}, {direction: 'right', timestamp: 100}]);
  });

  it('ignores a four-finger swipe entirely, so GNOME keeps its own gestures', () => {
    const h = gestureHarness();
    h.swipe(-300, 0, 4);
    expect(h.swipes).toEqual([]);
  });

  it('ignores a two-finger swipe', () => {
    const h = gestureHarness();
    h.swipe(-300, 0, 2);
    expect(h.swipes).toEqual([]);
  });

  it('ignores events that are not touchpad swipes at all', () => {
    // Every pointer motion and scroll on the system reaches this handler; a plain motion event answers
    // nothing useful to `get_gesture_phase()` and must be dropped before it is asked.
    const h = gestureHarness();
    h.send(0, 0, 0, 3, 7);
    h.send(1, -300, 0, 3, 7);
    h.send(2, 0, 0, 3, 7);
    expect(h.swipes).toEqual([]);
  });

  it('ignores a gesture already in flight when it starts listening', () => {
    // No BEGIN was seen, so there is no accumulated travel this class can vouch for.
    const h = gestureHarness();
    h.send(1, -300, 0);
    h.send(2, 0, 0);
    expect(h.swipes).toEqual([]);
  });

  it('claims every phase of a three-finger swipe, so GNOME never sees any part of it', () => {
    // Fix round 1, B2: this used to propagate. GNOME is pinned to two workspaces, so its own swipe
    // animates toward the ATTIC -- where parked windows live -- and the guard in `onWorkspacesChanged`
    // then corrects it back. Every phase, not only END: a claimed END after a propagated BEGIN would
    // still have let GNOME start animating.
    const h = gestureHarness();
    expect(h.send(0, 0, 0)).toBe(true);    // BEGIN
    expect(h.send(1, -300, 0)).toBe(true); // UPDATE
    expect(h.send(3, 0, 0)).toBe(true);    // CANCEL
    expect(h.send(2, 0, 0)).toBe(true);    // END
  });

  it('propagates a four-finger swipe, so GNOME keeps its own gestures working', () => {
    const h = gestureHarness();
    expect(h.swipe(-300, 0, 4)).toEqual([false, false, false, false, false]);
  });

  it('propagates an event that is not a touchpad swipe at all', () => {
    // Every pointer motion and scroll on the system passes through this handler; shadowing any of them
    // would break the desktop far beyond this feature.
    const h = gestureHarness();
    expect(h.send(0, 0, 0, 3, 7)).toBe(false);
    expect(h.send(1, -300, 0, 3, 10)).toBe(false);
  });

  it('stops reporting once the tracker is torn down', () => {
    const h = gestureHarness();
    h.tracker.disconnectAll();
    h.swipe(-300, 0);
    expect(h.swipes).toEqual([]);
  });
});
