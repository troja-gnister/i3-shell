import type Meta from 'gi://Meta';
import type {GeometryPort, Topology} from '../runtime/model';
import type {MonitorId, Rect, WindowId} from '../tree/node';
import {GeometryBackend, MonitorIds} from './geometryBackend';
import {log} from './log';

export class Geometry implements GeometryPort {
  private readonly _monitorIds = new MonitorIds();
  private readonly _backend: GeometryBackend<Meta.Window>;

  constructor(resolve: (id: WindowId) => Meta.Window | undefined) {
    this._backend = new GeometryBackend(
      resolve,
      (window, rect) => window.move_resize_frame(
        false,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
      ),
      () => this._readTopology(),
      (id, error) => log.error(`failed to apply geometry for window ${id}`, error),
    );
  }

  topology(): Topology | null {
    return this._backend.topology();
  }

  apply(rects: ReadonlyMap<WindowId, Rect>): ReadonlySet<WindowId> {
    return this._backend.apply(rects);
  }

  monitorId(index: number): MonitorId | undefined {
    return this._monitorIds.id(index);
  }

  destroy(): void {
    this._backend.destroy();
    this._monitorIds.clear();
  }

  private _readTopology(): Topology | null {
    const manager = global.backend.get_monitor_manager();
    const groups = new Map<number, string[]>();
    for (const monitor of manager.get_monitors() ?? []) {
      if (!monitor.is_active()) continue;
      const connector = monitor.get_connector();
      const index = manager.get_monitor_for_connector(connector);
      if (connector.length === 0 || !Number.isInteger(index) || index < 0) continue;
      const connectors = groups.get(index) ?? [];
      connectors.push(connector);
      groups.set(index, connectors);
    }

    const monitors = this._monitorIds.update(
      [...groups]
        .sort(([a], [b]) => a - b)
        .map(([index, connectors]) => ({index, connectors})),
    );
    if (monitors.length === 0) return null;

    const primary = this._monitorIds.id(global.display.get_primary_monitor());
    if (primary === undefined) return null;

    const workAreas = new Map<number, ReadonlyMap<MonitorId, Rect>>();
    const workspaceCount = global.workspace_manager.get_n_workspaces();
    if (workspaceCount < 1) return null;
    for (let workspaceIndex = 0; workspaceIndex < workspaceCount; workspaceIndex++) {
      const workspace = global.workspace_manager.get_workspace_by_index(workspaceIndex);
      if (!workspace) return null;
      const areas = new Map<MonitorId, Rect>();
      for (const monitor of monitors) {
        const area = workspace.get_work_area_for_monitor(monitor.index);
        const rect = {x: area.x, y: area.y, width: area.width, height: area.height};
        if (!usableRect(rect)) return null;
        areas.set(monitor.id, rect);
      }
      workAreas.set(workspaceIndex, areas);
    }

    return {primary, monitors, workAreas};
  }
}

function usableRect(rect: Rect): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}
