import {guard} from './util/signals';

/** The signal subset shared by Meta.Window and its Clutter actor. */
interface SignalObject {
  connect(signal: string, callback: () => void): number;
  disconnect(id: number): void;
}

/**
 * Mutter marks a window unmanaging before actor removal, focus changes and
 * workspace removal; unmanaged is emitted only after it leaves the MRU lists.
 * Even get_tab_list is unsafe in between, including from another window's signal.
 */
export class NativeWindowLifecycle<W extends SignalObject> {
  private readonly _handlers = new Map<W, number[]>();
  private readonly _retired = new WeakSet<W>();
  private readonly _retiring = new Set<W>();
  private _order: readonly W[] = [];

  constructor(private readonly _readOrder: () => readonly W[]) {}

  track(window: W): void {
    if (this._handlers.has(window) || this._retired.has(window)) return;
    // Guarded: these run inside Mutter's own emission, where an exception is
    // logged without the [i3-shell] prefix and would strand the window.
    const starting = window.connect('unmanaging', guard('unmanaging', () => {
      this._retired.add(window);
      this._retiring.add(window);
    }));
    const finished = window.connect('unmanaged', guard('unmanaged', () => {
      this._retiring.delete(window);
      this._order = this._order.filter(candidate => candidate !== window);
      this._disconnect(window);
    }));
    this._handlers.set(window, [starting, finished]);
  }

  isLive(window: W): boolean {
    return !this._retired.has(window);
  }

  existing(): readonly W[] {
    if (this._retiring.size === 0) {
      this._order = this._readOrder();
      for (const window of this._order) this.track(window);
    }
    return this._order.filter(window => this.isLive(window));
  }

  destroy(): void {
    for (const window of this._handlers.keys()) this._disconnect(window);
    this._retiring.clear();
    this._order = [];
  }

  private _disconnect(window: W): void {
    const ids = this._handlers.get(window);
    this._handlers.delete(window);
    for (const id of ids ?? []) window.disconnect(id);
  }
}

/** An actor may be destroyed before its pending window emits unmanaged. */
export function watchFirstFrame(actor: SignalObject, callback: () => void): () => void {
  let live = true;
  const frame = actor.connect('first-frame', guard('first-frame', callback));
  const destroyed = actor.connect('destroy', guard('actor destroy', () => { live = false; }));
  return () => {
    if (!live) return;
    live = false;
    actor.disconnect(frame);
    actor.disconnect(destroyed);
  };
}
