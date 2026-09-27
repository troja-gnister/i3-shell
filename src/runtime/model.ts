import type {WindowId, MonitorId, Rect} from '../tree/node';

/**
 * GNOME holds exactly two workspaces while the extension is enabled.
 *
 * `live` is the active one for the extension's whole lifetime and holds every window that should be on
 * screen. `attic` holds every window on a workspace no output is showing: Mutter does not render a
 * non-active workspace, so this is the hiding primitive, and it costs nothing.
 */
export const LIVE_WORKSPACE = 0;
export const ATTIC_WORKSPACE = 1;

export type WindowKind = 'tiled' | 'floating';
export interface WindowFacts {
  type: 'normal' | 'dialog' | 'modal-dialog' | 'utility' | 'ignored';
  transient: boolean;
  attached: boolean;
  resizable: boolean;
}
export interface WindowInfo {
  id: WindowId;
  kind: WindowKind;
  workspace: number;
  monitor: MonitorId | null;
  rect: Rect;
  title: string;
  wmClass: string | null;
  /** i3's `instance` criterion. Mutter: get_wm_class_instance(). */
  instance: string | null;
  /** i3's `app_id` criterion. Mutter: get_gtk_application_id(). */
  appId: string | null;
  /** i3's `window_role` criterion. Mutter: get_role(). */
  role: string | null;
  /** Meta.Window.urgent OR demands_attention -- a client may set either. */
  urgent: boolean;
  minimized: boolean;
  fullscreen: boolean;
  maximizedH: boolean;
  maximizedV: boolean;
  sticky: boolean;
  skipTaskbar: boolean;
}
export type WindowEvent =
  | {type: 'added'; id: WindowId}
  | {type: 'removed'; id: WindowId}
  | {type: 'focused'; id: WindowId | null}
  | {type: 'frame' | 'workspace' | 'minimized' | 'fullscreen' | 'maximized' | 'membership' | 'title' | 'urgent'; id: WindowId};

export interface WindowsPort {
  list(): readonly WindowInfo[];
  get(id: WindowId): WindowInfo | undefined;
  focused(): WindowId | null;
  activate(id: WindowId, timestamp: number): boolean;
  kill(id: WindowId, timestamp: number): boolean;
  fullscreen(id: WindowId, action: 'toggle' | 'enable' | 'disable'): boolean;
  moveToWorkspace(id: WindowId, index: number): boolean;
  unmaximize(id: WindowId): boolean;
  raise(id: WindowId): boolean;
}
export interface MonitorInfo {
  id: MonitorId;
  index: number;
  connectors: readonly string[];
}
export interface Topology {
  primary: MonitorId;
  monitors: readonly MonitorInfo[];
  /**
   * One work area per output, read from the *live* GNOME workspace.
   *
   * A work area belongs to an output, not to a workspace. It was keyed by workspace only because
   * GNOME owned workspaces; with two GNOME workspaces (live + attic) that keying would produce
   * entries for 0 and 1 alone, and every i3 workspace above 1 would miss.
   */
  workAreas: ReadonlyMap<MonitorId, Rect>;
}
export interface GeometryPort {
  topology(): Topology | null;
  apply(rects: ReadonlyMap<WindowId, Rect>): ReadonlySet<WindowId>;
}
export interface DeferredPort {
  defer(callback: () => void): number;
  cancel(token: number): void;
}
export interface PillState {
  name: string;
  /** Visible on the focused output. At most one pill across all outputs is focused. */
  focused: boolean;
  /** Visible on some output — possibly another one. i3bar's third state, which `active` could not express. */
  visible: boolean;
  occupied: boolean;
  /**
   * Any window the tree places on this workspace is urgent and this workspace is not focused. Derived
   * per commit from the tree, never separate state. Focusing a workspace is how i3 clears it.
   *
   * Styled from client.urgent: i3 takes bar colours from `bar { colors { … } }` and this project
   * ignores the bar block, so client.urgent is the only urgent colour the config supplies. A deliberate
   * divergence; see the spec.
   */
  urgent: boolean;
}
