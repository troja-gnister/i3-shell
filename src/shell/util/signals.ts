import {log} from '../log';

/** Anything with GObject-style connect/disconnect (GObjects and the shell's JS EventEmitters). */
export interface Connectable {
  connect(signal: string, callback: (...args: any[]) => any): number;
  disconnect(id: number): void;
}

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

  connect(object: Connectable, signal: string, callback: (...args: any[]) => any): number {
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
