import type {GeometryPort, MonitorInfo, Topology} from '../runtime/model';
import type {MonitorId, Rect, WindowId} from '../tree/node';

export class GeometryBackend<W> implements GeometryPort {
  private _destroyed = false;

  constructor(
    private readonly _resolve: (id: WindowId) => W | undefined,
    private readonly _moveResize: (window: W, rect: Rect) => void,
    private readonly _readTopology: () => Topology | null,
    private readonly _onError: (id: WindowId, error: unknown) => void,
  ) {}

  topology(): Topology | null {
    return this._destroyed ? null : this._readTopology();
  }

  apply(rects: ReadonlyMap<WindowId, Rect>): ReadonlySet<WindowId> {
    const applied = new Set<WindowId>();
    if (this._destroyed) return applied;
    for (const [id, rect] of rects) {
      try {
        const window = this._resolve(id);
        if (!window) continue;
        this._moveResize(window, rect);
        applied.add(id);
      } catch (error) {
        this._onError(id, error);
      }
    }
    return applied;
  }

  destroy(): void {
    this._destroyed = true;
  }
}

export class MonitorIds {
  private readonly _stableIds = new Map<string, MonitorId>();
  private readonly _currentIds = new Map<number, MonitorId>();
  private _nextId = 1;

  update(monitors: readonly {index: number; connectors: readonly string[]}[]): MonitorInfo[] {
    const current = new Map<number, MonitorId>();
    const result: MonitorInfo[] = [];
    for (const monitor of monitors) {
      const connectors = [...new Set(monitor.connectors.filter(connector => connector.length > 0))].sort();
      if (connectors.length === 0) continue;
      const key = JSON.stringify(connectors);
      let id = this._stableIds.get(key);
      if (id === undefined) {
        id = this._nextId++;
        this._stableIds.set(key, id);
      }
      current.set(monitor.index, id);
      result.push({id, index: monitor.index, connectors});
    }
    this._currentIds.clear();
    for (const [index, id] of current) this._currentIds.set(index, id);
    return result;
  }

  id(index: number): MonitorId | undefined {
    return this._currentIds.get(index);
  }

  clear(): void {
    this._stableIds.clear();
    this._currentIds.clear();
  }
}
