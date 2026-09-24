import type {WindowId, MonitorId, Rect} from '../tree/node';

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
  | {type: 'frame' | 'workspace' | 'minimized' | 'fullscreen' | 'maximized' | 'membership'; id: WindowId};

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
  workAreas: ReadonlyMap<number, ReadonlyMap<MonitorId, Rect>>;
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
  active: boolean;
  occupied: boolean;
}
