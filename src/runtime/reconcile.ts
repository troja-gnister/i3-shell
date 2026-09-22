import type {Rect, WindowId} from '../tree/node';

interface ReconciliationState {
  expected: Rect;
  generation: number;
  correctionQueued: boolean;
  retried: boolean;
  stubborn: boolean;
}

export interface ReconciliationStatus {
  expected: Rect;
  generation: number;
  retried: boolean;
  stubborn: boolean;
}

export class RectReconciler {
  private readonly _states = new Map<WindowId, ReconciliationState>();
  private _nextGeneration = 1;

  plan(
    expected: ReadonlyMap<WindowId, Rect>,
    forced: ReadonlySet<WindowId>,
  ): Map<WindowId, Rect> {
    const planned = new Map<WindowId, Rect>();
    for (const [id, target] of expected) {
      let state = this._states.get(id);
      if (!state || forced.has(id) || !rectEqual(state.expected, target)) {
        state = {
          expected: copyRect(target),
          generation: this._nextGeneration++,
          correctionQueued: false,
          retried: false,
          stubborn: false,
        };
        this._states.set(id, state);
        planned.set(id, copyRect(state.expected));
      } else if (state.correctionQueued) {
        state.correctionQueued = false;
        state.retried = true;
        planned.set(id, copyRect(state.expected));
      }
    }
    return planned;
  }

  observe(id: WindowId, actual: Rect, generation: number): boolean {
    const state = this._states.get(id);
    if (!state || state.generation !== generation) return false;
    if (rectEqual(state.expected, actual)) {
      state.correctionQueued = false;
      return false;
    }
    if (state.correctionQueued) return false;
    if (state.retried) {
      state.stubborn = true;
      return false;
    }
    state.correctionQueued = true;
    return true;
  }

  generation(id: WindowId): number | undefined {
    return this._states.get(id)?.generation;
  }

  status(id: WindowId): ReconciliationStatus | undefined {
    const state = this._states.get(id);
    if (!state) return undefined;
    return {
      expected: copyRect(state.expected),
      generation: state.generation,
      retried: state.retried,
      stubborn: state.stubborn,
    };
  }

  forget(id: WindowId): void {
    this._states.delete(id);
  }

  clear(): void {
    this._states.clear();
  }
}

function rectEqual(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function copyRect(rect: Rect): Rect {
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}
