import type Meta from 'gi://Meta';
import type {GeometryPort, Topology} from '../runtime/model';
import type {MonitorId, Rect, WindowId} from '../tree/node';
import {GeometryBackend, MonitorIds} from './geometryBackend';
import {readTopology} from './geometryTopology';
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
    return readTopology(this._monitorIds, {
      monitors: () => manager.get_monitors(),
      isActive: monitor => monitor.is_active(),
      connector: monitor => monitor.get_connector(),
      indexForConnector: connector => manager.get_monitor_for_connector(connector),
      primaryIndex: () => global.display.get_primary_monitor(),
      workspaceCount: () => global.workspace_manager.get_n_workspaces(),
      workspace: index => global.workspace_manager.get_workspace_by_index(index),
      workArea: (workspace, index) => workspace.get_work_area_for_monitor(index),
    });
  }
}
