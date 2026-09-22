import {classifyWindow} from '../runtime/classify';
import type {
  WindowEvent,
  WindowFacts,
  WindowInfo,
  WindowKind,
  WindowsPort,
} from '../runtime/model';
import type {WindowId} from '../tree/node';

type ChangeEvent = Exclude<WindowEvent['type'], 'added'>;
type Dispose = () => void;

export interface WindowBackend<W extends object> {
  existing(): readonly W[];
  facts(window: W): WindowFacts;
  info(window: W): Omit<WindowInfo, 'id' | 'kind'>;
  focused(): W | null;
  watchCreated(callback: (window: W) => void): Dispose;
  watch(window: W, callback: (event: ChangeEvent) => void): Dispose;
  firstFrame(window: W, callback: () => void): Dispose;
  activate(window: W, timestamp: number): boolean;
  kill(window: W, timestamp: number): boolean;
  fullscreen(window: W, action: 'toggle' | 'enable' | 'disable'): boolean;
  moveToWorkspace(window: W, index: number): boolean;
  unmaximize(window: W): boolean;
  raise(window: W): boolean;
}

interface PendingWindow {
  disposeWatch: Dispose;
  disposeFrame: Dispose;
}

interface TrackedWindow<W> {
  window: W;
  kind: WindowKind;
  disposeWatch: Dispose;
}

const NO_FOCUS_EVENT = Symbol('no-focus-event');

export class WindowTracker<W extends object> implements WindowsPort {
  private readonly _pending = new Map<W, PendingWindow>();
  private readonly _byId = new Map<WindowId, TrackedWindow<W>>();
  private readonly _idByWindow = new Map<W, WindowId>();
  private _disposeCreated: Dispose | null = null;
  private _nextId = 1;
  private _started = false;
  private _destroyed = false;
  private _lastFocus: WindowId | null | typeof NO_FOCUS_EVENT = NO_FOCUS_EVENT;

  constructor(
    private readonly _native: WindowBackend<W>,
    private readonly _emit: (event: WindowEvent) => void,
  ) {}

  start(): void {
    if (this._started || this._destroyed) return;
    this._started = true;
    this._disposeCreated = this._native.watchCreated(window => this._beginPending(window));
    for (const window of this._native.existing()) this._adoptReady(window);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._disposeCreated?.();
    this._disposeCreated = null;
    for (const pending of this._pending.values()) {
      pending.disposeFrame();
      pending.disposeWatch();
    }
    for (const tracked of this._byId.values()) tracked.disposeWatch();
    this._pending.clear();
    this._byId.clear();
    this._idByWindow.clear();
    this._lastFocus = NO_FOCUS_EVENT;
  }

  resolve(id: WindowId): W | undefined {
    return this._byId.get(id)?.window;
  }

  list(): readonly WindowInfo[] {
    if (this._destroyed) return [];
    const result: WindowInfo[] = [];
    for (const window of this._native.existing()) {
      const id = this._idByWindow.get(window);
      if (id === undefined) continue;
      const tracked = this._byId.get(id);
      if (tracked) result.push(this._snapshot(id, tracked));
    }
    return result;
  }

  get(id: WindowId): WindowInfo | undefined {
    if (this._destroyed) return undefined;
    const tracked = this._byId.get(id);
    return tracked ? this._snapshot(id, tracked) : undefined;
  }

  focused(): WindowId | null {
    if (this._destroyed) return null;
    const window = this._native.focused();
    return window ? this._idByWindow.get(window) ?? null : null;
  }

  activate(id: WindowId, timestamp: number): boolean {
    return this._operate(id, window => this._native.activate(window, timestamp));
  }

  kill(id: WindowId, timestamp: number): boolean {
    return this._operate(id, window => this._native.kill(window, timestamp));
  }

  fullscreen(id: WindowId, action: 'toggle' | 'enable' | 'disable'): boolean {
    return this._operate(id, window => this._native.fullscreen(window, action));
  }

  moveToWorkspace(id: WindowId, index: number): boolean {
    return this._operate(id, window => this._native.moveToWorkspace(window, index));
  }

  unmaximize(id: WindowId): boolean {
    return this._operate(id, window => this._native.unmaximize(window));
  }

  raise(id: WindowId): boolean {
    return this._operate(id, window => this._native.raise(window));
  }

  private _beginPending(window: W): void {
    if (this._destroyed || this._pending.has(window) || this._idByWindow.has(window)) return;
    const pending: PendingWindow = {
      disposeWatch: this._native.watch(window, event => this._onEvent(window, event)),
      disposeFrame: () => undefined,
    };
    this._pending.set(window, pending);
    pending.disposeFrame = this._native.firstFrame(window, () => this._makeReady(window));
  }

  private _adoptReady(window: W): void {
    if (this._destroyed || this._pending.has(window) || this._idByWindow.has(window)) return;
    const pending: PendingWindow = {
      disposeWatch: this._native.watch(window, event => this._onEvent(window, event)),
      disposeFrame: () => undefined,
    };
    this._pending.set(window, pending);
    this._makeReady(window);
  }

  private _makeReady(window: W): void {
    const pending = this._pending.get(window);
    if (!pending || this._destroyed || this._idByWindow.has(window)) return;
    this._pending.delete(window);
    pending.disposeFrame();
    const kind = classifyWindow(this._native.facts(window));
    if (!kind) {
      pending.disposeWatch();
      return;
    }
    const id = this._nextId++;
    this._idByWindow.set(window, id);
    this._byId.set(id, {window, kind, disposeWatch: pending.disposeWatch});
    this._emit({type: 'added', id});
  }

  private _onEvent(window: W, event: ChangeEvent): void {
    if (event === 'removed') {
      this._remove(window);
      return;
    }
    const id = this._idByWindow.get(window);
    if (id === undefined || this._destroyed) return;
    if (event === 'focused') {
      const focused = this.focused();
      if (focused === this._lastFocus) return;
      this._lastFocus = focused;
      this._emit({type: 'focused', id: focused});
      return;
    }
    this._emit({type: event, id});
  }

  private _remove(window: W): void {
    const pending = this._pending.get(window);
    if (pending) {
      this._pending.delete(window);
      pending.disposeFrame();
      pending.disposeWatch();
      return;
    }
    const id = this._idByWindow.get(window);
    if (id === undefined) return;
    const tracked = this._byId.get(id);
    this._idByWindow.delete(window);
    this._byId.delete(id);
    tracked?.disposeWatch();
    if (!this._destroyed) this._emit({type: 'removed', id});
  }

  private _snapshot(id: WindowId, tracked: TrackedWindow<W>): WindowInfo {
    return {id, kind: tracked.kind, ...this._native.info(tracked.window)};
  }

  private _operate(id: WindowId, operation: (window: W) => boolean): boolean {
    if (this._destroyed) return false;
    const window = this.resolve(id);
    return window ? operation(window) : false;
  }
}
