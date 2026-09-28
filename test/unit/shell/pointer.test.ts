import {afterEach, describe, expect, it, vi} from 'vitest';
import {SignalTracker} from '../../../src/shell/util/signals';
import type {Rect} from '../../../src/tree/node';

/** Every `warp_pointer` call the fake seat has seen, as [x, y] pairs. */
const seatCalls: Array<[number, number]> = [];
const seat = {warp_pointer: (x: number, y: number) => { seatCalls.push([x, y]); }};

vi.mock('gi://Clutter', () => ({default: {get_default_backend: () => ({get_default_seat: () => seat})}}));
// Mutter 18 has no `Meta.Rectangle`; `get_monitor_index_for_rect` takes an `Mtk.Rectangle` instead (see
// the class doc comment on Pointer). The fake keeps the same shape -- a constructed object with the
// four fields -- without caring what monitor lookup the real class does with it; `display.
// get_monitor_index_for_rect` below answers whatever the harness was told to report, not real geometry.
vi.mock('gi://Mtk', () => ({
  default: {
    Rectangle: class FakeRectangle {
      x: number; y: number; width: number; height: number;
      constructor(props: {x: number; y: number; width: number; height: number}) {
        this.x = props.x; this.y = props.y; this.width = props.width; this.height = props.height;
      }
    },
  },
}));

// Typed inline, not via a static import of pointer.ts: that file's own top-level `global.backend` /
// `global.display` references only typecheck under the native `tsconfig.json` program (whose ambient
// `@girs` types describe them), not under this Node-side `tsconfig.test.json` program -- the same
// reason nativeWindowLifecycle.test.ts types `ManagedWindows` inline rather than importing it from
// `../../../src/shell/windows`.
const {Pointer} = await vi.importActual<{
  Pointer: new (tracker: SignalTracker, onCrossed: (monitorIndex: number) => void) => {
    warpTo(rect: Rect): void;
  };
}>('../../../src/shell/pointer');

interface FakeCursorTracker {
  connect(signal: string, callback: () => void): number;
  disconnect(id: number): void;
  get_pointer(): [{x: number; y: number} | null, null];
}

/**
 * Wires a real `Pointer` against fake `global.backend`/`global.display`. `movePointerTo` is the fake
 * compositor's half: it sets the position `get_pointer()` will answer *and* the monitor index
 * `get_monitor_index_for_rect` will answer for it, then fires `position-invalidated` -- exactly what a
 * real cursor tracker does on every pointer motion, monitor crossing or not.
 */
function pointerHarness(onCrossed: (monitorIndex: number) => void) {
  let handler: (() => void) | null = null;
  let nextId = 1;
  let point: {x: number; y: number} | null = null;
  let reportedMonitor = 0;
  const cursor: FakeCursorTracker = {
    connect: (signal, callback) => {
      if (signal === 'position-invalidated') handler = callback;
      return nextId++;
    },
    disconnect: () => { handler = null; },
    get_pointer: () => [point, null],
  };
  vi.stubGlobal('backend', {get_cursor_tracker: () => cursor});
  vi.stubGlobal('display', {get_monitor_index_for_rect: () => reportedMonitor});
  const tracker = new SignalTracker();
  const crossed: number[] = [];
  const pointer = new Pointer(tracker, index => { crossed.push(index); onCrossed(index); });
  return {
    pointer, tracker,
    movePointerTo(monitor: number, x: number, y: number): void {
      reportedMonitor = monitor;
      point = {x, y};
      handler?.();
    },
    crossings: (): number[] => crossed.slice(),
    warps: (): Array<[number, number]> => seatCalls.slice(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  seatCalls.length = 0;
});

describe('Pointer', () => {
  it('reports a crossing only when the pointer changes output', async () => {
    const crossed: number[] = [];
    const h = await pointerHarness(index => crossed.push(index));
    h.movePointerTo(0, 10, 10);
    h.movePointerTo(0, 20, 20); // same output: not a crossing
    h.movePointerTo(1, 4000, 30);
    h.movePointerTo(1, 4100, 30);
    expect(crossed).toEqual([1]); // the first position establishes the baseline, it is not a crossing
  });

  it('warps the pointer to the centre of a rect', async () => {
    const h = await pointerHarness(() => {});
    h.pointer.warpTo({x: 3840, y: 28, width: 1920, height: 1052});
    expect(h.warps()).toEqual([[4800, 554]]);
  });

  it('disconnects its cursor subscription when the tracker is torn down', async () => {
    const h = await pointerHarness(() => {});
    h.tracker.disconnectAll();
    h.movePointerTo(1, 4000, 30);
    expect(h.crossings()).toEqual([]);
  });
});
