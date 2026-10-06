/**
 * TYPE-LEVEL ASSERTIONS FOR `SignalTracker.connect`. No runtime behaviour, nothing imports this file.
 *
 * It exists because the assertions in `test/unit/shell/util/signals.test.ts` can only use a hand-made
 * `$signals` fake: `tsconfig.test.json` excludes `src/shell/**`, and the real `@girs` ambient types are
 * only in scope under `tsconfig.json`. So the fake proves the conditional type works; THIS file proves it
 * works against the actual stubs, for the actual emitters this extension connects to -- including the one
 * call that shipped broken.
 *
 * Every assertion below is self-verifying in both directions, which is the whole point of writing them as
 * `@ts-expect-error`: if the checking is weakened, the expected error stops appearing and `tsc` fails with
 * `TS2578: Unused '@ts-expect-error' directive`; if a call that must keep compiling stops compiling, `tsc`
 * fails on the call. `npm run typecheck` is therefore the test runner for this file, and there is no way
 * to leave it passing vacuously.
 *
 * It is not imported on purpose. `esbuild.mjs` bundles from the single entry point `src/extension.ts`, so
 * this file is typechecked by `tsconfig.json`, whose `include` glob covers every .ts file under `src`,
 * and never reaches `dist`.
 */
import type Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {SignalTracker} from './signals';

export function assertSignalTrackerChecksItsHandlers(tracker: SignalTracker): void {
  // ---------------------------------------------------------------------------------------------------
  // THE BUG THAT SHIPPED, src/shell/gestures.ts. `captured-event` is declared `(event: Event) => ...` in
  // `@girs`, and GJS prepends the emitter, so the handler really receives `(stage, event)`. The original
  // handler took `(event)` alone, got the Stage there, and `event.type()` threw on EVERY event in the
  // session. 25 unit tests passed against it; both `tsc` programs were blind to it; only a native run
  // found it. Below is that exact handler, and it must not compile.
  // @ts-expect-error -- `Clutter.Stage` is not assignable to the `event` parameter: the real bug, caught.
  tracker.connect(global.stage, 'captured-event', (event: Clutter.Event) => event.type());

  // The shape gestures.ts ships today, which must keep compiling. `Stage` is assignable to `Actor`, so
  // naming the first parameter by its base type is allowed, as is returning `boolean` for `boolean | void`.
  tracker.connect(global.stage, 'captured-event',
    (_actor: Clutter.Actor, event: Clutter.Event) => event.type() === 0);

  // ---------------------------------------------------------------------------------------------------
  // A misspelled signal name on a real GObject. Today this connects to nothing and fails silently for the
  // life of the session, with no error anywhere.
  // @ts-expect-error -- Meta.Display has `workareas-changed`, not `workarea-changed`.
  tracker.connect(global.display, 'workarea-changed', () => {});

  // A real signal on that same emitter, to show the rejection above is about the NAME and not about the
  // emitter being unreadable. Without this line the assertion above would also pass if `Meta.Display`
  // carried no usable signal map at all, which is exactly the vacuous-fixture failure mode.
  tracker.connect(global.display, 'workareas-changed', () => {});

  // Wrong argument type on a real signal: `accelerator-activated` is
  // `(display, action: number, device: Clutter.InputDevice, timestamp: number)`.
  // @ts-expect-error -- `action` is a number, not a string.
  tracker.connect(global.display, 'accelerator-activated', (_d: unknown, _action: string) => {});

  // ---------------------------------------------------------------------------------------------------
  // `Meta.Display::closing`. The brief for this task recorded it as uncheckable, "absent from every
  // SignalSignatures map in @girs" -- it is not. `meta-18.d.ts:4553` declares `closing: () => void` inside
  // `Meta.Display.SignalSignatures` (which begins at 4538), unquoted because the name needs no quotes,
  // which is why searching for `"closing"` found nothing. So `src/extension.ts` keeps the CHECKED
  // `connect` for it, and these two assertions are what pins that decision: the signal is in the map, and
  // a handler whose first parameter cannot be the Display is rejected.
  tracker.connect(global.display, 'closing', () => {});
  // @ts-expect-error -- GJS passes the Display first, and `Meta.Display` is not a number.
  tracker.connect(global.display, 'closing', (_display: number) => {});

  // ---------------------------------------------------------------------------------------------------
  // THE ONE SITE THE STUBS CANNOT DESCRIBE. This assertion is what makes `connectUnchecked` an honest
  // escape hatch rather than decoration: it proves the plain `connect` genuinely rejects the signal, so
  // the one call site in `src/extension.ts` is not using `connectUnchecked` out of habit.
  //
  // `Main.layoutManager::monitors-changed` is real; `@girs/gnome-shell`'s `layout.d.ts` declares
  // `class LayoutManager extends GObject.Object` and no `SignalSignatures` of its own, so the class
  // carries only `GObject.Object`'s map.
  // @ts-expect-error -- not in GObject.Object's signal map, so `HandlerFor` resolves to `never`.
  tracker.connect(Main.layoutManager, 'monitors-changed', () => {});
  tracker.connectUnchecked(Main.layoutManager, 'monitors-changed', () => {});

  // ---------------------------------------------------------------------------------------------------
  // `Main.sessionMode` is declared `any`. Nothing can be known about it, so it must stay permissive --
  // this is `src/shell/session.ts:14`, and it is the assertion the `IsAny` branch of `HandlerFor` exists
  // for. No `@ts-expect-error`: this call MUST compile.
  tracker.connect(Main.sessionMode, 'updated', () => {});
}
