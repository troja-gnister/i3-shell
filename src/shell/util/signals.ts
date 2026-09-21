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
