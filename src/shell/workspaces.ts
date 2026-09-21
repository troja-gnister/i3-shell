import Meta from 'gi://Meta';
import type {SignalTracker} from './util/signals';

export interface WorkspacesPort {
  readonly count: number;
  readonly activeIndex: number;
  activate(index: number, timestamp: number): boolean;
}

export class Workspaces implements WorkspacesPort {
  constructor(private readonly _tracker: SignalTracker, onChanged: () => void) {
    const manager = global.workspace_manager;
    _tracker.connect(manager, 'active-workspace-changed', onChanged);
    _tracker.connect(manager, 'notify::n-workspaces', onChanged);
    _tracker.connect(global.display, 'window-created', (_display: Meta.Display, window: Meta.Window) => {
      const ids: number[] = [];
      ids.push(_tracker.connect(window, 'workspace-changed', onChanged));
      ids.push(_tracker.connect(window, 'unmanaged', () => {
        for (const id of ids)
          _tracker.disconnect(window, id);
        onChanged();
      }));
      onChanged();
    });
  }

  get count(): number {
    return global.workspace_manager.get_n_workspaces();
  }

  get activeIndex(): number {
    return global.workspace_manager.get_active_workspace_index();
  }

  activate(index: number, timestamp: number): boolean {
    const workspace = global.workspace_manager.get_workspace_by_index(index);
    if (!workspace)
      return false;
    workspace.activate(timestamp || global.get_current_time());
    return true;
  }

  /** True when a normal (task-bar-visible) window lives on the workspace — drives the pill style. */
  isOccupied(index: number): boolean {
    const workspace = global.workspace_manager.get_workspace_by_index(index);
    if (!workspace)
      return false;
    return workspace.list_windows().some(w =>
      w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar());
  }
}
