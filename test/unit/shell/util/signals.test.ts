import {describe, expect, it} from 'vitest';
import {ClosingGate, SignalTracker, type Connectable} from '../../../../src/shell/util/signals';

/**
 * Meta.Display::closing fires while the session tears down. Today every
 * compositor-signal handler in extension.ts keeps running after it, so a
 * handler still in flight can call geometry on a window being destroyed or
 * write to chrome the shell is disposing (the same defect shape Phase 2B
 * fixed once for the panel indicator, now multiplied by Phase 3A's borders,
 * frames, tab rows and bars).
 *
 * ClosingGate is the shared flag: rather than every consumer guarding
 * itself, extension.ts wraps each compositor-signal handler in
 * `unlessClosing`, and one `close()` call (from the `closing` signal) stops
 * all of them.
 */
describe('ClosingGate', () => {
  it('lets a wrapped handler run normally before close()', () => {
    const gate = new ClosingGate();
    const calls: number[] = [];
    const handler = gate.unlessClosing((n: number) => { calls.push(n); });

    handler(1);
    handler(2);

    expect(calls).toEqual([1, 2]);
    expect(gate.closing).toBe(false);
  });

  it('stops every handler it wraps once close() has run, from one shared flag', () => {
    const gate = new ClosingGate();
    const monitors: number[] = [];
    const workareas: number[] = [];
    // Two independently-wrapped handlers, standing in for monitors-changed
    // and workareas-changed: one close() call must silence both, which is
    // the whole point of a shared gate over guarding each consumer alone.
    const onMonitorsChanged = gate.unlessClosing(() => { monitors.push(1); });
    const onWorkareasChanged = gate.unlessClosing(() => { workareas.push(1); });

    onMonitorsChanged();
    gate.close();
    onMonitorsChanged();
    onWorkareasChanged();

    expect(monitors).toEqual([1]);
    expect(workareas).toEqual([]);
    expect(gate.closing).toBe(true);
  });

  it('forwards arguments through to the wrapped handler', () => {
    const gate = new ClosingGate();
    let seen: [string, number] | null = null;
    const handler = gate.unlessClosing((a: string, b: number) => { seen = [a, b]; });

    handler('x', 2);

    expect(seen).toEqual(['x', 2]);
  });
});

/**
 * A generated @girs GObject, reduced to the two things `connect` reads: the `Connectable` shape and the
 * `$signals` map @girs puts on every generated class. Nothing here imports a `gi://` type, so these
 * assertions hold under both TypeScript programs.
 */
interface Pinger extends Connectable {
  $signals: {ping: (count: number) => void};
}

function pinger() {
  const calls: Array<{signal: string; args: unknown[]}> = [];
  let next = 1;
  const handlers = new Map<number, (...args: unknown[]) => unknown>();
  const emitter: Pinger = {
    // A real @girs `$signals` is a type-only declaration; a plain object satisfies it here and costs
    // nothing, which is simpler than asserting the shape onto a literal that lacks it.
    $signals: {ping: () => {}},
    connect(signal, callback) {
      const id = next++;
      handlers.set(id, callback);
      calls.push({signal, args: []});
      return id;
    },
    disconnect(id) { handlers.delete(id); },
  };
  return {
    emitter,
    calls,
    /** What GJS really does: the emitting object first, then the signal's own arguments. */
    emit(count: number): void {
      for (const handler of handlers.values()) handler(emitter, count);
    },
  };
}

/**
 * Exactly what `@girs/gnome-shell`'s hand-written `main.d.ts` declares `Main.sessionMode` to be:
 * `export declare const sessionMode: any`. A named, one-line alias rather than a bare `any` at the use
 * site, because the `any` IS the thing under test -- `src/shell/session.ts:14` connects to this emitter,
 * and a conditional type over `any` resolves to the union of both branches, which is why `HandlerFor`
 * has to ask `IsAny` before it asks anything else. See the `IsAny` doc comment.
 */
type StubbedAsAny = any;

/** `Main.sessionMode`: an emitter the stubs describe with `any`, so nothing about it can be checked. */
function anyEmitter() {
  let next = 1;
  const handlers = new Map<number, (...args: unknown[]) => unknown>();
  const emitter: StubbedAsAny = {
    connect(_signal: string, callback: (...args: unknown[]) => unknown) {
      const id = next++;
      handlers.set(id, callback);
      return id;
    },
    disconnect(id: number) { handlers.delete(id); },
  };
  return {
    emitter,
    emitAnything(...args: unknown[]): void {
      for (const handler of handlers.values()) handler(...args);
    },
  };
}

/** A shell JS EventEmitter: a `connect`/`disconnect` pair and no signal map at all. */
function looseEmitter() {
  let next = 1;
  const handlers = new Map<number, (...args: unknown[]) => unknown>();
  const emitter: Connectable = {
    connect(_signal, callback) { const id = next++; handlers.set(id, callback); return id; },
    disconnect(id) { handlers.delete(id); },
  };
  return {
    emitter,
    emitAnything(...args: unknown[]): void {
      for (const handler of handlers.values()) handler(...args);
    },
  };
}

describe('SignalTracker.connect checks the handler against the emitter signal map', () => {
  it('accepts a handler shaped the way GJS really calls it, and invokes it that way', () => {
    const tracker = new SignalTracker();
    const {emitter, emit} = pinger();
    const seen: Array<[unknown, number]> = [];

    tracker.connect(emitter, 'ping', (source: Pinger, count: number) => { seen.push([source, count]); });
    emit(7);

    expect(seen).toEqual([[emitter, 7]]);
    tracker.disconnectAll();
    emit(8);
    expect(seen).toHaveLength(1);
  });

  it('rejects the three shapes that have actually gone wrong in this repo', () => {
    const tracker = new SignalTracker();
    const {emitter} = pinger();

    // THE BUG THAT SHIPPED. src/shell/gestures.ts connected `(event: Clutter.Event) => ...` to
    // `captured-event`, so the first argument was the Stage, `.type()` did not exist on it, and the
    // gesture threw on every event in the session while 25 unit tests passed. The emitter is not
    // assignable to the signal's first argument, which is exactly what makes this detectable.
    // @ts-expect-error -- one argument where GJS passes the emitter and then the signal's own.
    tracker.connect(emitter, 'ping', (count: number) => { void count; });

    // @ts-expect-error -- right arity, wrong argument type.
    tracker.connect(emitter, 'ping', (_source: Pinger, count: string) => { void count; });

    // @ts-expect-error -- no such signal. Today this connects to nothing and fails silently forever.
    tracker.connect(emitter, 'pong', (_source: Pinger) => {});
  });

  it('leaves an emitter with no signal map exactly as permissive as it was', () => {
    // The shell's own JS objects: Main.sessionMode is declared `any` and Main.layoutManager is a
    // hand-written stub with no SignalSignatures. Neither can be checked, and neither may be broken.
    const tracker = new SignalTracker();
    const {emitter, emitAnything} = looseEmitter();
    const seen: unknown[][] = [];

    tracker.connect(emitter, 'whatever-it-is-called', (...args: unknown[]) => { seen.push(args); });
    emitAnything('a', 1, true);

    expect(seen).toEqual([['a', 1, true]]);
  });

  it('leaves an emitter the stubs type as `any` permissive, instead of rejecting every handler', () => {
    // src/shell/session.ts:14 verbatim: `tracker.connect(Main.sessionMode, 'updated', () => ...)`, whose
    // emitter @girs declares `any`. The brief for this task asserted `any` would "fall through the
    // design's own loose branch untouched"; it does not. `SignalMap<any>` is `unknown`, not `never`, so
    // `keyof` it is `never`, every signal looks absent from the map and the handler is checked against
    // `never` -- which rejected this exact correct call until `HandlerFor` grew its `IsAny` branch.
    const tracker = new SignalTracker();
    const {emitter, emitAnything} = anyEmitter();
    const seen: number[] = [];

    tracker.connect(emitter, 'updated', () => { seen.push(1); });
    emitAnything();

    expect(seen).toEqual([1]);
  });

  it('connectUnchecked connects a signal the stubs do not describe, and is still tracked', () => {
    // The real one is `Main.layoutManager::monitors-changed`: @girs declares `class LayoutManager extends
    // GObject.Object` with no SignalSignatures of its own, so the class carries only GObject.Object's map
    // and the signal cannot be looked up. (`Meta.Display::closing`, which this task's brief listed as the
    // second such signal, turned out to BE in the map at meta-18.d.ts:4553 and uses the checked connect.)
    const tracker = new SignalTracker();
    const {emitter, emit} = pinger();
    const seen: number[] = [];

    tracker.connectUnchecked(emitter, 'monitors-changed', () => { seen.push(1); });
    emit(0);
    expect(seen).toEqual([1]);

    tracker.disconnectAll();
    emit(0);
    expect(seen).toEqual([1]);
  });

  it('still logs instead of letting an exception escape into a signal handler', () => {
    const tracker = new SignalTracker();
    const {emitter, emit} = pinger();
    tracker.connect(emitter, 'ping', () => { throw new Error('boom'); });
    expect(() => emit(1)).not.toThrow();
  });
});
