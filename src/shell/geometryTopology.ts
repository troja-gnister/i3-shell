import type {Topology} from '../runtime/model';
import type {MonitorId, Rect} from '../tree/node';
import type {MonitorIds} from './geometryBackend';

export interface TopologySource<M, W> {
  monitors(): readonly M[] | null;
  isActive(monitor: M): boolean;
  connector(monitor: M): string;
  indexForConnector(connector: string): number;
  /**
   * How many logical monitors Mutter has RIGHT NOW -- `MetaMonitorManager.get_logical_monitors().length`.
   *
   * This exists because `indexForConnector` and `workArea` are two separate questions to Mutter and a
   * reconfiguration can land between them. `get_monitor_for_connector` answers out of the MONITOR list
   * (an active monitor's logical-monitor number), while `get_work_area_for_monitor` indexes the LOGICAL
   * monitor list, and mid-reconfigure the first can still name a number the second no longer has. That
   * is not a theory: `--hotplug` produced
   * `meta_monitor_manager_get_logical_monitor_from_number: assertion '(unsigned int) number <
   * g_list_length (manager->logical_monitors)' failed`, and `readTopology`'s own `index < 0` guard rules
   * out the only other way that check can fail. Asking Mutter how many it has is the only way to tell,
   * because the number is not wrong in any way its own value reveals.
   */
  logicalMonitorCount(): number;
  primaryIndex(): number;
  /**
   * Unused by readTopology's own work-area logic (it now reads only workspace 0), and kept on the
   * interface only because src/shell/geometry.ts still implements it. It used to say that file was out
   * of scope to edit; `logicalMonitorCount` above edited it, so that reason is gone and dropping this
   * member is simply a cleanup nobody has done yet.
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
  // Read once, before the loop, so every index in this pass is judged against one answer rather than
  // against a count that could move underneath it.
  const logicalCount = source.logicalMonitorCount();
  for (const monitor of nativeMonitors) {
    if (!source.isActive(monitor)) continue;
    const connector = source.connector(monitor);
    if (connector.length === 0) return null;
    const index = source.indexForConnector(connector);
    if (!Number.isInteger(index) || index < 0) return null;
    // A number Mutter's logical-monitor list does not have. Rejected HERE, before `workArea` is called
    // with it: asking anyway is a `libmutter-CRITICAL` pair per call (see `logicalMonitorCount`), and the
    // rect that comes back is zeroed, so `usableRect` below would reject this read a moment later
    // anyway. The outcome is the same `null` -- "Mutter is mid-reconfiguration, publish nothing, the next
    // commit will read a settled backend" -- reached without making the compositor complain about us.
    if (index >= logicalCount) return null;
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
