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

}
