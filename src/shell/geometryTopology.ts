import type {Topology} from '../runtime/model';
import type {MonitorId, Rect} from '../tree/node';
import type {MonitorIds} from './geometryBackend';

export interface TopologySource<M, W> {
  monitors(): readonly M[] | null;
  isActive(monitor: M): boolean;
  connector(monitor: M): string;
  indexForConnector(connector: string): number;
  primaryIndex(): number;
  /**
   * Unused by readTopology's own work-area logic (it now reads only workspace 0), but kept on the
   * interface because the real GNOME-backed source in src/shell/geometry.ts still implements it and
   * that file is outside this task's scope to edit.
   */
  workspaceCount(): number;
  workspace(index: number): W | null;
  workArea(workspace: W, monitorIndex: number): Rect | null;
}

export function readTopology<M, W>(
  ids: MonitorIds,
  source: TopologySource<M, W>,
): Topology | null {
  const groups = new Map<number, string[]>();
  const nativeMonitors = source.monitors();
  if (!nativeMonitors) return null;
  for (const monitor of nativeMonitors) {
    if (!source.isActive(monitor)) continue;
    const connector = source.connector(monitor);
    if (connector.length === 0) return null;
    const index = source.indexForConnector(connector);
    if (!Number.isInteger(index) || index < 0) return null;
    const connectors = groups.get(index) ?? [];
    connectors.push(connector);
    groups.set(index, connectors);
  }
  if (groups.size === 0) return null;

  const primaryIndex = source.primaryIndex();
  if (!Number.isInteger(primaryIndex) || !groups.has(primaryIndex)) return null;

  // Workspace 0 is `live`: the only GNOME workspace any visible window occupies.
  const liveWorkspace = source.workspace(0);
  if (!liveWorkspace) return null;
  const rawWorkAreas = new Map<number, Rect>();
  for (const monitorIndex of groups.keys()) {
    const area = source.workArea(liveWorkspace, monitorIndex);
    if (!area || !usableRect(area)) return null;
    rawWorkAreas.set(monitorIndex, copyRect(area));
  }

  const monitors = ids.update(
    [...groups]
      .sort(([a], [b]) => a - b)
      .map(([index, connectors]) => ({index, connectors})),
  );
  const idsByIndex = new Map(monitors.map(monitor => [monitor.index, monitor.id]));
  const primary = idsByIndex.get(primaryIndex);
  if (primary === undefined)
    throw new Error('validated primary monitor was not assigned an id');

  const workAreas = new Map<MonitorId, Rect>();
  for (const [monitorIndex, area] of rawWorkAreas) {
    const id = idsByIndex.get(monitorIndex);
    if (id === undefined) throw new Error('validated monitor was not assigned an id');
    workAreas.set(id, area);
  }
  return {primary, monitors, workAreas};
}

function usableRect(rect: Rect): boolean {
  return Number.isFinite(rect.x)
    && Number.isFinite(rect.y)
    && Number.isFinite(rect.width)
    && Number.isFinite(rect.height)
    && rect.width > 0
    && rect.height > 0;
}

function copyRect(rect: Rect): Rect {
  return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}
