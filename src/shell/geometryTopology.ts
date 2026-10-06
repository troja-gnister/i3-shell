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
   * It exists because `indexForConnector` and `workArea` ask about two DIFFERENT lists.
   * `get_monitor_for_connector` answers out of the monitor list, returning that monitor's logical-monitor
   * number; `get_work_area_for_monitor` indexes the logical-monitor list. Nothing in those APIs promises
   * a number from the first is a valid index into the second, and a stale number does not announce itself
   * -- its value looks like any other. Asking how many logical monitors there are is the only way to
   * check.
   *
   * WHAT THIS IS NOT. It is not a fix for the `libmutter-CRITICAL` pair that
   * `test/integration/phase5-checks.py --hotplug` provokes
   * (`meta_monitor_manager_get_logical_monitor_from_number`, then
   * `meta_workspace_get_work_area_for_monitor`). Measurement attributes those to GNOME's own hotplug
   * handling: src/shell/geometry.ts holds this project's only call into either API, it was instrumented
   * to log the index it passes and the live logical count on every call, and across 106 calls of a
   * `--hotplug` run every index was below that count, with our first work-area call of the
   * reconfiguration landing 39 ms AFTER the criticals were already in the log. The guard this count feeds
   * has never been observed to fire, in that run or any other.
   *
   * WHY IT IS HERE ANYWAY. test/integration/criticals.sh now excludes
   * `meta_workspace_get_work_area_for_monitor: assertion 'logical_monitor != NULL' failed` by exact text,
   * in both scopes, so the native gate can no longer see that line. It is also exactly what a bad call of
   * OURS would print. This count, `readTopology`'s `index >= logicalCount` guard and that guard's unit
   * test are what replace the detection the exclusion costs.
   *
   * WHAT IT CAN AND CANNOT CATCH, said plainly. `readTopology` runs synchronously, so Mutter's two lists
   * cannot change underneath a single call: no reconfiguration can land between the two questions within
   * one pass. The case left over is a snapshot that is internally inconsistent -- a monitor list naming a
   * logical-monitor number the logical-monitor list of that same instant does not hold. Nothing in the
   * API rules that out, and nothing here has demonstrated it either.
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
    // A number Mutter's monitor list handed us that its logical-monitor list does not hold. Rejected
    // HERE, before `workArea` is ever called with it. This has never been observed to fire: the
    // `--hotplug` criticals were measured to GNOME's own code, not to this call site (see
    // `logicalMonitorCount` above for that measurement). It is here because the native gate now excludes
    // `meta_workspace_get_work_area_for_monitor`'s assertion by text, so a bad call of ours would be
    // invisible there -- this line is what makes one impossible instead, and
    // test/unit/shell/geometryTopology.test.ts's "never asks Mutter for the work area of a logical
    // monitor number it no longer has" is what pins it.
    // Correctness never depended on it. The returned rect would have to be usable to reach a window: if
    // Mutter leaves it zeroed, as the assertion's early return suggests and as the unit test's fake
    // assumes -- an assumption about Mutter, not a measurement -- `usableRect` below rejects the read and
    // `readTopology` returns the same `null` this line returns. Publish nothing; the next commit reads a
    // settled backend.
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
