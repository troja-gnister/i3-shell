import {describe, expect, it} from 'vitest';
import type {WindowFacts, WindowInfo, WindowEvent} from '../../../src/runtime/model';
import {WindowTracker, type WindowBackend} from '../../../src/shell/windowTracker';

const normal: WindowFacts = {
  type: 'normal', transient: false, attached: false, resizable: true,
};

type NativeWindow = object;
type EventType = Exclude<WindowEvent['type'], 'added'>;
type Operation = readonly [name: string, window: NativeWindow, ...args: unknown[]];

function fakeWindowBackend() {
  const facts = new Map<NativeWindow, WindowFacts>();
  const info = new Map<NativeWindow, Omit<WindowInfo, 'id' | 'kind'>>();
  const order: NativeWindow[] = [];
  const createdCallbacks = new Set<(window: NativeWindow) => void>();
  const watchCallbacks = new Map<NativeWindow, Set<(event: EventType) => void>>();
  const frameCallbacks = new Map<NativeWindow, Set<() => void>>();
  const operations: Operation[] = [];
  let focusedWindow: NativeWindow | null = null;

  const subscribe = <T>(callbacks: Set<T>, callback: T): (() => void) => {
    callbacks.add(callback);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      callbacks.delete(callback);
    };
  };
  const perWindow = <T>(map: Map<NativeWindow, Set<T>>, window: NativeWindow): Set<T> => {
    let callbacks = map.get(window);
    if (!callbacks) {
      callbacks = new Set<T>();
      map.set(window, callbacks);
    }
    return callbacks;
  };
  const operate = (name: string, window: NativeWindow, ...args: unknown[]): boolean => {
    operations.push([name, window, ...args]);
    return true;
  };

  const backend: WindowBackend<NativeWindow> = {
    isLive: () => true,
    existing: () => [...order].sort((a, b) => {
      const workspace = info.get(a)!.workspace - info.get(b)!.workspace;
      return workspace || order.indexOf(a) - order.indexOf(b);
    }),
    facts: window => facts.get(window)!,
    info: window => ({...info.get(window)!, rect: {...info.get(window)!.rect}}),
    focused: () => focusedWindow,
    watchCreated: callback => subscribe(createdCallbacks, callback),
    watch: (window, callback) => subscribe(perWindow(watchCallbacks, window), callback),
    firstFrame: (window, callback) => subscribe(perWindow(frameCallbacks, window), callback),
    activate: (window, timestamp) => operate('activate', window, timestamp),
    kill: (window, timestamp) => operate('kill', window, timestamp),
    fullscreen: (window, action) => operate('fullscreen', window, action),
    moveToWorkspace: (window, index) => operate('moveToWorkspace', window, index),
    unmaximize: window => operate('unmaximize', window),
    raise: window => operate('raise', window),
  };

  function create(windowFacts: WindowFacts, workspace = 0): NativeWindow {
    const window = {};
    facts.set(window, {...windowFacts});
    info.set(window, {
      workspace,
      monitor: 11,
      rect: {x: workspace * 100, y: 20, width: 80, height: 60},
      title: `window-${facts.size}`,
      wmClass: `Class${facts.size}`,
      minimized: false,
      fullscreen: false,
      maximizedH: false,
      maximizedV: false,
      sticky: false,
      skipTaskbar: false,
    });
    order.push(window);
    for (const callback of [...createdCallbacks]) callback(window);
    return window;
  }

  function draw(window: NativeWindow): void {
    for (const callback of [...(frameCallbacks.get(window) ?? [])]) callback();
  }

  function remove(window: NativeWindow): void {
    const index = order.indexOf(window);
    if (index >= 0) order.splice(index, 1);
    for (const callback of [...(watchCallbacks.get(window) ?? [])]) callback('removed');
  }

  function focus(window: NativeWindow | null): void {
    focusedWindow = window;
    if (window) {
      const index = order.indexOf(window);
      if (index >= 0) {
        order.splice(index, 1);
        const workspace = info.get(window)!.workspace;
        const firstOnWorkspace = order.findIndex(candidate => info.get(candidate)!.workspace === workspace);
        order.splice(firstOnWorkspace < 0 ? order.length : firstOnWorkspace, 0, window);
      }
      for (const callback of [...(watchCallbacks.get(window) ?? [])]) callback('focused');
    } else {
      for (const callbacks of watchCallbacks.values())
        for (const callback of [...callbacks]) callback('focused');
    }
  }

  function notify(window: NativeWindow, event: EventType): void {
    for (const callback of [...(watchCallbacks.get(window) ?? [])]) callback(event);
  }

  function subscriptionCount(): number {
    let count = createdCallbacks.size;
    for (const callbacks of watchCallbacks.values()) count += callbacks.size;
    for (const callbacks of frameCallbacks.values()) count += callbacks.size;
    return count;
  }

  return {
    backend, create, draw, remove, focus, notify, subscriptionCount,
    info, operations, createdCallbacks, watchCallbacks, frameCallbacks,
  };
}

describe('WindowTracker', () => {
  it('waits for first frame, cancels pending windows, and removes both identity directions before emitting', () => {
    const f = fakeWindowBackend();
    const events: WindowEvent[] = [];
    let tracker!: WindowTracker<NativeWindow>;
    let stateDuringRemoval: [NativeWindow | undefined, number | null] | undefined;
    tracker = new WindowTracker(f.backend, event => {
      events.push(event);
      if (event.type === 'removed') stateDuringRemoval = [tracker.resolve(event.id), tracker.focused()];
    });
    tracker.start();

    const gone = f.create(normal);
    expect(tracker.list()).toEqual([]);
    f.remove(gone);
    f.draw(gone);
    expect(events.filter(event => event.type === 'added')).toEqual([]);

    const live = f.create(normal);
    f.draw(live);
    const id = tracker.list()[0]!.id;
    f.focus(live);
    f.remove(live);
    f.remove(live);

    expect(tracker.resolve(id)).toBeUndefined();
    expect(tracker.kill(id, 7)).toBe(false);
    expect(events.filter(event => event.type === 'removed')).toEqual([{type: 'removed', id}]);
    expect(stateDuringRemoval).toEqual([undefined, null]);
    tracker.destroy();
    tracker.destroy();
    expect(f.subscriptionCount()).toBe(0);
  });

  it('adopts preexisting mapped windows immediately without subscribing to first-frame', () => {
    const f = fakeWindowBackend();
    const first = f.create(normal, 0);
    const ignored = f.create({...normal, type: 'ignored'}, 0);
    const second = f.create({...normal, type: 'dialog'}, 1);
    const events: WindowEvent[] = [];
    const tracker = new WindowTracker(f.backend, event => events.push(event));

    tracker.start();

    expect(tracker.list().map(window => [window.kind, window.workspace])).toEqual([
      ['tiled', 0], ['floating', 1],
    ]);
    expect(tracker.resolve(tracker.list()[0]!.id)).toBe(first);
    expect(tracker.resolve(tracker.list()[1]!.id)).toBe(second);
    expect(tracker.list().some(window => tracker.resolve(window.id) === ignored)).toBe(false);
    expect([...f.frameCallbacks.values()].reduce((sum, callbacks) => sum + callbacks.size, 0)).toBe(0);
    expect(events.filter(event => event.type === 'added')).toHaveLength(2);
    tracker.destroy();
  });

  it('ignores untracked windows and never reuses a removed id', () => {
    const f = fakeWindowBackend();
    const tracker = new WindowTracker(f.backend, () => undefined);
    tracker.start();
    const first = f.create(normal);
    f.draw(first);
    const firstId = tracker.list()[0]!.id;
    f.remove(first);
    const splash = f.create({...normal, type: 'ignored'});
    f.draw(splash);
    expect(tracker.list()).toEqual([]);
    expect(f.subscriptionCount()).toBe(1);
    const second = f.create(normal);
    f.draw(second);
    expect(tracker.list()[0]!.id).toBeGreaterThan(firstId);
    tracker.destroy();
  });

  it('returns fresh snapshots in per-workspace MRU order', () => {
    const f = fakeWindowBackend();
    const tracker = new WindowTracker(f.backend, () => undefined);
    tracker.start();
    const first = f.create(normal, 0);
    const second = f.create(normal, 0);
    const third = f.create(normal, 1);
    for (const window of [first, second, third]) f.draw(window);

    f.focus(second);
    expect(tracker.list().map(window => window.title)).toEqual(['window-2', 'window-1', 'window-3']);
    const firstId = tracker.list()[1]!.id;
    f.info.get(first)!.title = 'renamed';
    f.info.get(first)!.rect.x = 444;
    expect(tracker.get(firstId)).toMatchObject({title: 'renamed', rect: {x: 444}});
    expect(tracker.list().map(window => window.title)).toEqual(['window-2', 'renamed', 'window-3']);
    tracker.destroy();
  });

  it('deduplicates ready and focus notifications while forwarding live changes', () => {
    const f = fakeWindowBackend();
    const events: WindowEvent[] = [];
    const tracker = new WindowTracker(f.backend, event => events.push(event));
    tracker.start();
    const window = f.create(normal);
    f.draw(window);
    f.draw(window);
    const id = tracker.list()[0]!.id;
    f.focus(window);
    f.focus(window);
    for (const event of ['frame', 'workspace', 'minimized', 'fullscreen', 'maximized'] as const)
      f.notify(window, event);

    expect(events).toEqual([
      {type: 'added', id},
      {type: 'focused', id},
      {type: 'frame', id},
      {type: 'workspace', id},
      {type: 'minimized', id},
      {type: 'fullscreen', id},
      {type: 'maximized', id},
    ]);
    f.focus(null);
    f.focus(null);
    expect(events.slice(-1)).toEqual([{type: 'focused', id: null}]);
    tracker.destroy();
  });

  it('targets every operation by tracked id and rejects all operations after destroy', () => {
    const f = fakeWindowBackend();
    const tracker = new WindowTracker(f.backend, () => undefined);
    tracker.start();
    const window = f.create(normal);
    f.draw(window);
    const id = tracker.list()[0]!.id;

    expect(tracker.activate(id, 10)).toBe(true);
    expect(tracker.kill(id, 20)).toBe(true);
    expect(tracker.fullscreen(id, 'enable')).toBe(true);
    expect(tracker.moveToWorkspace(id, 3)).toBe(true);
    expect(tracker.unmaximize(id)).toBe(true);
    expect(tracker.raise(id)).toBe(true);
    expect(f.operations).toEqual([
      ['activate', window, 10],
      ['kill', window, 20],
      ['fullscreen', window, 'enable'],
      ['moveToWorkspace', window, 3],
      ['unmaximize', window],
      ['raise', window],
    ]);

    tracker.destroy();
    const operationCount = f.operations.length;
    expect(tracker.activate(id, 10)).toBe(false);
    expect(tracker.kill(id, 20)).toBe(false);
    expect(tracker.fullscreen(id, 'disable')).toBe(false);
    expect(tracker.moveToWorkspace(id, 4)).toBe(false);
    expect(tracker.unmaximize(id)).toBe(false);
    expect(tracker.raise(id)).toBe(false);
    expect(f.operations).toHaveLength(operationCount);
    expect(tracker.list()).toEqual([]);
    expect(tracker.get(id)).toBeUndefined();
    expect(tracker.focused()).toBeNull();
  });

  // classifyWindow returns null for exactly one reason now: type === 'ignored'.
  // `sticky` used to be able to produce null too, which made `_makeReady` call
  // `pending.disposeWatch()` and return, dropping the window forever with no
  // subscription left to notice it coming back. Pin the narrowed contract:
  // every admitted type keeps its watch and gets an id; only 'ignored' is
  // disposed of with none.
  it.each([
    ['normal', normal],
    ['dialog', {...normal, type: 'dialog'}],
    ['modal dialog', {...normal, type: 'modal-dialog'}],
    ['utility', {...normal, type: 'utility'}],
  ] satisfies Array<[string, WindowFacts]>)('allocates an id and keeps the watch for an admitted %s window', (_name, facts) => {
    const f = fakeWindowBackend();
    const events: WindowEvent[] = [];
    const tracker = new WindowTracker(f.backend, event => events.push(event));
    tracker.start();
    const baseline = f.subscriptionCount();

    const window = f.create(facts);
    f.draw(window);

    expect(events).toEqual([{type: 'added', id: 1}]);
    expect(f.subscriptionCount()).toBe(baseline + 1); // frame watch disposed, change watch kept
    tracker.destroy();
  });

  it('disposes the watch and allocates no id for an ignored window', () => {
    const f = fakeWindowBackend();
    const events: WindowEvent[] = [];
    const tracker = new WindowTracker(f.backend, event => events.push(event));
    tracker.start();
    const baseline = f.subscriptionCount();

    const window = f.create({...normal, type: 'ignored'});
    f.draw(window);

    expect(events).toEqual([]);
    expect(f.subscriptionCount()).toBe(baseline); // both frame and change watch disposed
    tracker.destroy();
  });
});
