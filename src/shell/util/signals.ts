import type GObject from 'gi://GObject';
import {log} from '../log';

/** Anything with GObject-style connect/disconnect (GObjects and the shell's JS EventEmitters). */
export interface Connectable {
  connect(signal: string, callback: (...args: any[]) => any): number;
  disconnect(id: number): void;
}

/**
 * The signal map @girs declares on every GENERATED GObject class (`$signals: Foo.SignalSignatures`), or
 * `never` for anything that has none -- the shell's hand-written stubs and its plain JS EventEmitters.
 */
type SignalMap<O> = O extends {$signals: infer S} ? S : never;

/**
 * Whether `T` is `any`, which here means "an emitter the stubs describe with `any`".
 *
 * `Main.sessionMode` is declared `export declare const sessionMode: any` in `@girs/gnome-shell`'s
 * hand-written `main.d.ts`, and `any` needs asking about SEPARATELY rather than falling out of
 * `SignalMap` on its own: TypeScript resolves a conditional whose checked type is `any` to the union of
 * both branches, instantiating `infer S` at its constraint, so `SignalMap<any>` is `unknown` -- NOT
 * `never`. `keyof unknown` is `never`, so without this branch every signal on an `any` emitter looks
 * absent from the map and `HandlerFor` answers `never`, rejecting handlers that are not wrong and cannot
 * be known to be wrong. Verified against `tsc` on 2026-10-06, after `src/shell/session.ts:14` failed
 * exactly that way.
 *
 * `0 extends 1 & T` is the standard test: `1 & any` is `any`, which `0` extends, while `1 & <anything
 * else>` never admits `0`.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * The handler `signal` really takes on `object`.
 *
 * `[SignalMap<O>] extends [never]` and not a bare `extends never`: a conditional whose checked type
 * resolves to `never` is the one case the distribution rule turns into `never` itself, and the tuple
 * wrapper is the standard way to ask the question literally.
 *
 * Four answers, in order:
 * 1. an emitter typed `any` keeps exactly today's permissiveness -- nothing is known about it, and
 *    pretending otherwise would reject correct handlers (`Main.sessionMode`; see `IsAny`);
 * 2. an emitter with no `$signals` map keeps exactly today's permissiveness, because nothing can be known
 *    about it either -- `Main.layoutManager` is a hand-written stub keyed against `GObject.Object`'s map
 *    alone, and the shell's plain JS EventEmitters have no map at all;
 * 3. a signal the emitter's map does not name resolves to `never`, so every handler is rejected. This
 *    catches a misspelled ORDINARY signal name, which today connects to nothing and fails silently for
 *    the life of the session -- but NOT a misspelled `notify::` one. Read that limit before trusting it:
 *    `GObject.Object.SignalSignatures` carries `[key: \`notify::${string}\`]: (pspec: ParamSpec) => void`
 *    (`gobject-2.0.d.ts:3641`), so the map admits ANY `notify::`-prefixed key. `notify::n-worksapces`
 *    typechecks clean, exactly as it does today; `n-worksapces-notify` does not. So this repo's two
 *    `notify::` sites -- `src/shell/workspaces.ts:13` and `src/extension.ts:299` -- get the handler's
 *    SHAPE checked (the index signature's value type still forces `(source, pspec)`) and their NAME not
 *    checked at all. Both verified against `tsc` on 2026-10-06;
 * 4. otherwise `GObject.SignalCallback` prepends the emitter to the signal's own arguments, which is what
 *    GJS really passes and what @girs's own `connect` overloads do. Reused rather than re-derived, so the
 *    two cannot drift.
 *
 * ONE SIGNATURE, DELIBERATELY NOT AN OVERLOAD PAIR. A typed overload beside a permissive one would be
 * useless here: overload resolution falls back to the permissive member whenever the typed one fails,
 * which is exactly the case this exists to catch.
 */
type HandlerFor<O, K extends string> =
  IsAny<O> extends true
    ? (...args: any[]) => any
    : [SignalMap<O>] extends [never]
      ? (...args: any[]) => any
      : K extends keyof SignalMap<O>
        ? GObject.SignalCallback<O, SignalMap<O>[K]>
        : never;

/** Wraps a callback so an exception is logged instead of escaping into a Shell signal handler (§15). */
export function guard<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return ((...args: any[]) => {
    try {
      return fn(...args);
    } catch (e) {
      log.error(`unhandled error in ${name}`, e);
      return undefined;
    }
  }) as T;
}

/**
 * Tracks whether Meta.Display has announced it is closing (session
 * teardown). GNOME tears its own windows and actors down underneath the
 * extension once that fires, but a compositor signal serviced afterward can
 * still call geometry on a window being destroyed or write to chrome the
 * shell is disposing -- the same defect shape Phase 2B fixed once for the
 * panel indicator, multiplied by Phase 3A's borders, frames, tab rows and
 * bars. Rather than every handler guarding itself, extension.ts wraps each
 * compositor-signal handler in `unlessClosing` and connects `close()` to the
 * `closing` signal, so one flag stops all of them.
 */
export class ClosingGate {
  private _closing = false;

  /** Meta.Display::closing's own handler. */
  close(): void {
    this._closing = true;
  }

  get closing(): boolean {
    return this._closing;
  }

  /** Wraps a compositor-signal handler so it no-ops once `close()` has run. */
  unlessClosing<T extends (...args: any[]) => void>(fn: T): T {
    return ((...args: any[]) => {
      if (this._closing) return;
      fn(...args);
    }) as T;
  }
}

/** Remembers every connection so disable() can drop them all (§8.4 item 7). */
export class SignalTracker {
  private _connections: Array<{object: Connectable; id: number}> = [];

  /**
   * Connects `callback` and remembers the connection so `disconnectAll()` can drop it.
   *
   * The handler is checked against the emitter's own signal signature wherever @girs describes one --
   * see `HandlerFor`. This exists because `src/shell/gestures.ts` shipped `(event: Clutter.Event)` where
   * Clutter passes `(actor, event)`: it threw on every event in the session, 25 unit tests passed against
   * it, both `tsc` programs were blind to it because the blindness was in THIS signature, and only a
   * native run found it. Use `connectUnchecked` below only for a signal the stubs genuinely omit.
   *
   * WHAT CAN STILL LOOK CHECKED AND NOT BE: the check is only ever as good as `object`'s STATIC type, so
   * an emitter widened on its way in -- to `Connectable`, to `any`, or through a parameter or a field
   * declared as either -- loses its `$signals` map and takes the permissive branch silently, with no
   * diagnostic anywhere. Pass generated GObjects to this method at their own concrete types.
   *
   * AND THE BIGGER LIMIT, WHICH IS THE REAL COVERAGE: this method is not on the path of most connections
   * in this extension. There are 26 direct `.connect()` calls in `src/` that never reach it, spread over
   * ten files, every one of them in `src/shell/**`; measured 2026-10-06 with
   *
   *     rg '\.connect\(' src/ |
   *       rg -v 'signals\.connect|connectUnchecked|tracker\.connect|^src/shell/util/signals\.ts:'
   *
   * and the last two exclusions are what an earlier recipe here was missing: without them it prints 49,
   * because `tracker.connect` calls DO reach this method and this file's own three ARE it. Every one of
   * the 26 is typed by @girs rather than by `HandlerFor`. The exact bug this signature exists to catch
   * STILL COMPILES CLEAN when written that way: appending
   * `global.stage.connect('captured-event', (event: Clutter.Event) => event.type())` to
   * `signals.typecheck.ts` and running `tsc -p tsconfig.json` exits 0, because @girs declares a loose
   * second overload beside the typed one (`connect(signal: string, callback: (...args: any[]) => any)`,
   * e.g. `clutter-18.d.ts:19978` on `Clutter.Actor`) and overload resolution falls through to it -- the
   * same reason `HandlerFor` is one signature and not an overload pair. So this typing covers the calls
   * that come through `SignalTracker`, which is the right place for a lifetime-tracked connection to be,
   * and nothing else.
   */
  connect<O extends Connectable, K extends string>(object: O, signal: K, callback: HandlerFor<O, K>): number {
    // One widening, at the one boundary where it is unavoidable: `Connectable.connect` is declared with
    // the loose callback type (it has to be -- it describes every emitter at once), and `HandlerFor` is
    // an unresolved conditional inside this body. Nothing below this line knows less than it did before.
    return this.connectUnchecked(object, signal, callback as unknown as (...args: any[]) => any);
  }

  /**
   * `connect` without the handler check, for a signal `@girs` does not describe at all.
   *
   * Named this way on purpose: `rg connectUnchecked src/` is the whole audit. There is exactly ONE such
   * signal in this repo, verified against `node_modules/@girs` on 2026-10-06:
   *
   * - `Main.layoutManager::monitors-changed` -- `@girs/gnome-shell`'s `layout.d.ts` declares
   *   `class LayoutManager extends GObject.Object` and no `SignalSignatures` of its own, so the class
   *   carries only `GObject.Object`'s map (`notify` and its per-property details, nothing else).
   *
   * The task brief listed a second one, `Meta.Display::closing`, on the grounds that it "appears in no
   * @girs SignalSignatures map anywhere". It does: `meta-18.d.ts:4553` declares it inside
   * `Meta.Display.SignalSignatures` as `closing: () => void`, unquoted because it needs no quoting, which
   * is why a search for `"closing"` missed it. `src/extension.ts` therefore uses the CHECKED `connect` for
   * it, and `signals.typecheck.ts` pins that it really is checked.
   *
   * A second caller needs a reason in a comment, and probably needs the stubs fixed instead.
   */
  connectUnchecked(object: Connectable, signal: string, callback: (...args: any[]) => any): number {
    const id = object.connect(signal, guard(signal, callback));
    this._connections.push({object, id});
    return id;
  }

  disconnect(object: Connectable, id: number): void {
    const index = this._connections.findIndex(c => c.object === object && c.id === id);
    if (index < 0)
      return;
    this._connections.splice(index, 1);
    try {
      object.disconnect(id);
    } catch (e) {
      log.error('disconnect failed', e);
    }
  }

  disconnectAll(): void {
    for (const {object, id} of this._connections.splice(0)) {
      try {
        object.disconnect(id);
      } catch (e) {
        log.error('disconnect failed', e);
      }
    }
  }
}
