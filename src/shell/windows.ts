export interface WindowsPort {
  killFocused(timestamp: number): boolean;
  fullscreenFocused(action: 'toggle' | 'enable' | 'disable'): boolean;
  moveFocusedToWorkspace(index: number): boolean;
}

/** Phase 1: operations on the focused window only. Phase 2 grows this into the full window adapter (§8). */
export class Windows implements WindowsPort {
  killFocused(timestamp: number): boolean {
    const window = global.display.focus_window;
    if (!window)
      return false;
    window.delete(timestamp || global.get_current_time());
    return true;
  }

  fullscreenFocused(action: 'toggle' | 'enable' | 'disable'): boolean {
    const window = global.display.focus_window;
    if (!window)
      return false;
    const wantFullscreen = action === 'toggle' ? !window.is_fullscreen() : action === 'enable';
    if (wantFullscreen)
      window.make_fullscreen();
    else
      window.unmake_fullscreen();
    return true;
  }

  moveFocusedToWorkspace(index: number): boolean {
    const window = global.display.focus_window;
    if (!window)
      return false;
    window.change_workspace_by_index(index, false);
    return true;
  }
}
