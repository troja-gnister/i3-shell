import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import type {WindowEvent, WindowFacts, WindowInfo} from '../runtime/model';
import type {MonitorId} from '../tree/node';
import {existingWindows} from './windowEnumeration';
import {WindowTracker, type WindowBackend} from './windowTracker';

export class ManagedWindows extends WindowTracker<Meta.Window> {
  constructor(
    emit: (event: WindowEvent) => void,
    monitorId: (index: number) => MonitorId | undefined,
  ) {
    super(nativeWindowBackend(monitorId), emit);
  }
}

function nativeWindowBackend(
  monitorId: (index: number) => MonitorId | undefined,
): WindowBackend<Meta.Window> {
  return {
    existing: nativeExistingWindows,
    facts: windowFacts,
    info: window => windowInfo(window, monitorId),
    focused: () => global.display.focus_window,
    watchCreated: callback => {
      const id = global.display.connect('window-created', (_display, window) => callback(window));
      return disconnectOnce(global.display, id);
    },
    watch: (window, callback) => watchWindow(window, callback),
    firstFrame: (window, callback) => {
      const actor = window.get_compositor_private<Meta.WindowActor>();
      const id = actor.connect('first-frame', callback);
      return disconnectOnce(actor, id);
    },
    activate: (window, timestamp) => {
      window.activate(timestamp);
      return true;
    },
    kill: (window, timestamp) => {
      window.delete(timestamp);
      return true;
    },
    fullscreen: (window, action) => {
      const enable = action === 'toggle' ? !window.is_fullscreen() : action === 'enable';
      if (enable)
        window.make_fullscreen();
      else
        window.unmake_fullscreen();
      return true;
    },
    moveToWorkspace: (window, index) => {
      if (!global.workspace_manager.get_workspace_by_index(index)) return false;
      window.change_workspace_by_index(index, false);
      return true;
    },
    unmaximize: window => {
      window.unmaximize();
      return true;
    },
    raise: window => {
      window.raise();
      return true;
    },
  };
}

function nativeExistingWindows(): readonly Meta.Window[] {
  const manager = global.workspace_manager;
  return existingWindows({
    workspaceCount: () => manager.get_n_workspaces(),
    workspace: index => manager.get_workspace_by_index(index),
    normalAllMru: Meta.TabList.NORMAL_ALL_MRU,
    get_tab_list: (type, workspace) => global.display.get_tab_list(type, workspace),
    workspaceIndex: window => window.get_workspace().index(),
  });
}

function windowFacts(window: Meta.Window): WindowFacts {
  return {
    type: windowType(window.get_window_type()),
    skipTaskbar: window.is_skip_taskbar(),
    transient: window.get_transient_for() !== null,
    attached: window.is_attached_dialog(),
    sticky: window.is_on_all_workspaces(),
    resizable: window.allows_resize(),
  };
}

function windowType(type: Meta.WindowType): WindowFacts['type'] {
  switch (type) {
    case Meta.WindowType.NORMAL: return 'normal';
    case Meta.WindowType.DIALOG: return 'dialog';
    case Meta.WindowType.MODAL_DIALOG: return 'modal-dialog';
    case Meta.WindowType.UTILITY: return 'utility';
    case Meta.WindowType.DESKTOP:
    case Meta.WindowType.DOCK:
    case Meta.WindowType.TOOLBAR:
    case Meta.WindowType.MENU:
    case Meta.WindowType.SPLASHSCREEN:
    case Meta.WindowType.DROPDOWN_MENU:
    case Meta.WindowType.POPUP_MENU:
    case Meta.WindowType.TOOLTIP:
    case Meta.WindowType.NOTIFICATION:
    case Meta.WindowType.COMBO:
    case Meta.WindowType.DND:
    case Meta.WindowType.OVERRIDE_OTHER:
    default:
      return 'ignored';
  }
}

function windowInfo(
  window: Meta.Window,
  monitorId: (index: number) => MonitorId | undefined,
): Omit<WindowInfo, 'id' | 'kind'> {
  const rect = window.get_frame_rect();
  return {
    workspace: window.get_workspace().index(),
    monitor: monitorId(window.get_monitor()) ?? null,
    rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
    title: window.get_title(),
    wmClass: window.get_wm_class(),
    minimized: window.minimized,
    fullscreen: window.is_fullscreen(),
    maximizedH: window.maximized_horizontally,
    maximizedV: window.maximized_vertically,
  };
}

function watchWindow(
  window: Meta.Window,
  callback: (event: Exclude<WindowEvent['type'], 'added'>) => void,
): () => void {
  const dispose: Array<() => void> = [];
  const connectWindow = (signal: string, event: Exclude<WindowEvent['type'], 'added'>): void => {
    const id = window.connect(signal, () => callback(event));
    dispose.push(disconnectOnce(window, id));
  };

  connectWindow('unmanaged', 'removed');
  connectWindow('position-changed', 'frame');
  connectWindow('size-changed', 'frame');
  connectWindow('workspace-changed', 'workspace');
  connectWindow('notify::minimized', 'minimized');
  connectWindow('notify::fullscreen', 'fullscreen');
  connectWindow('notify::appears-focused', 'focused');
  const focusId = global.display.connect('notify::focus-window', () => callback('focused'));
  dispose.push(disconnectOnce(global.display, focusId));

  let maximizedIdle = 0;
  const maximizedChanged = (): void => {
    if (maximizedIdle !== 0) return;
    maximizedIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      maximizedIdle = 0;
      callback('maximized');
      return GLib.SOURCE_REMOVE;
    });
  };
  const maximizedH = window.connect('notify::maximized-horizontally', maximizedChanged);
  const maximizedV = window.connect('notify::maximized-vertically', maximizedChanged);
  dispose.push(disconnectOnce(window, maximizedH), disconnectOnce(window, maximizedV));

  let live = true;
  return () => {
    if (!live) return;
    live = false;
    if (maximizedIdle !== 0) {
      GLib.source_remove(maximizedIdle);
      maximizedIdle = 0;
    }
    for (const disconnect of dispose.splice(0)) disconnect();
  };
}

function disconnectOnce(object: {disconnect(id: number): void}, id: number): () => void {
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    object.disconnect(id);
  };
}
