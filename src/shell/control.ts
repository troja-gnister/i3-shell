import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Engine} from '../engine';
import {ControlObject} from './controlObject';
import type {Launcher} from './launcher';
import {log} from './log';
import type {SessionWatcher} from './session';
import type {TilingToggle} from './tilingToggle';
import {guard} from './util/signals';

const BUS_NAME = 'org.i3shell.Control';
const OBJECT_PATH = '/org/i3shell/Control';

const CONTROL_IFACE = `<node>
  <interface name="org.i3shell.Control">
    <method name="Command">
      <arg type="s" direction="in" name="command"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="GetState"><arg type="s" direction="out" name="json"/></method>
    <method name="GetConfigStatus"><arg type="s" direction="out" name="json"/></method>
    <method name="GetTree"><arg type="s" direction="out" name="json"/></method>
    <method name="GetWindows"><arg type="s" direction="out" name="json"/></method>
    <signal name="TreeChanged"/>
  </interface>
</node>`;

const DEBUG_IFACE = `<node>
  <interface name="org.i3shell.Debug">
    <method name="SimulateSessionMode"><arg type="b" direction="in" name="locked"/></method>
    <method name="PressKey">
      <arg type="s" direction="in" name="accel"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="Relayout"/>
    <method name="LauncherState"><arg type="s" direction="out" name="json"/></method>
    <method name="WarpPointer">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="PointerPosition">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
    <method name="SimulateSwipe">
      <arg type="s" direction="in" name="direction"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="SetTiling">
      <arg type="b" direction="in" name="enabled"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="MutterWindows"><arg type="s" direction="out" name="json"/></method>
    <method name="TilingToggleBox"><arg type="s" direction="out" name="json"/></method>
    <method name="QuickSettingsMenu">
      <arg type="b" direction="in" name="open"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
    <method name="ClickAt">
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
  </interface>
</node>`;

const MODIFIER_KEYVALS: Record<string, number> = {
  super: Clutter.KEY_Super_L,
  shift: Clutter.KEY_Shift_L,
  control: Clutter.KEY_Control_L,
  alt: Clutter.KEY_Alt_L,
};

/** "<Super><Shift>4" → [KEY_Super_L, KEY_Shift_L, KEY_4]; null for names Clutter does not define (XF86 keys). */
export function accelToKeyvals(accel: string): number[] | null {
  const keyvals: number[] = [];
  let rest = accel;
  const re = /^<([A-Za-z]+)>/;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const keyval = MODIFIER_KEYVALS[m[1].toLowerCase()];
    if (keyval === undefined)
      return null;
    keyvals.push(keyval);
    rest = rest.slice(m[0].length);
  }
  const keyval = (Clutter as unknown as Record<string, unknown>)[`KEY_${rest}`];
  if (typeof keyval !== 'number')
    return null;
  keyvals.push(keyval);
  return keyvals;
}

/**
 * One window as MUTTER describes it. Every field is read off `Meta.Window` itself, never off anything
 * this extension remembers; see `MutterWindows` for why that distinction is the whole point.
 */
interface MutterWindowReading {
  /** `Meta.Window.get_id()`. Not the engine's `WindowId`, which is a counter the engine owns. */
  nativeId: number;
  title: string;
  /** `get_workspace().index()`, or -1 when Mutter says the window is on no workspace at all. */
  workspace: number;
  minimized: boolean;
  skipTaskbar: boolean;
  sticky: boolean;
  /** Which enumeration found it: `tabList`, and/or `workspace<N>`. See `MutterWindows`. */
  sources: string[];
}

/** Mutter's own answer to "how many workspaces are there and what is on each of them". */
interface MutterReading {
  nWorkspaces: number;
  activeWorkspace: number;
  /** `Main.modalCount`: the Shell's own count of live modal grabs, not the launcher's bookkeeping. */
  modalCount: number;
  windows: MutterWindowReading[];
}

/** Test-build only: lets the integration harness press keys and fake the lock screen. */
export class DebugObject {
  private _keyboard: Clutter.VirtualInputDevice | null = null;
  private _pointer: Clutter.VirtualInputDevice | null = null;

  constructor(private readonly _session: SessionWatcher, private readonly _engine: Engine,
    private readonly _launcher: Launcher, private readonly _toggle: TilingToggle,
    private readonly _setTiling: (enabled: boolean) => void) {}

  /**
   * Switch tiling off or on exactly as the Quick Settings switch does, and report what MUTTER had
   * either side of the call.
   *
   * `_setTiling` is the closure `src/extension.ts` hands to `TilingToggle` -- `Engine.setTilingEnabled`
   * followed by `TilingToggle.setChecked(engine.tilingEnabled)` -- and not `Engine.setTilingEnabled`
   * directly. One route in, deliberately: a scenario driving the engine past the snap-back would leave
   * the visible switch free to disagree with the engine and nothing would ever notice, and the snap-back
   * is the line that makes a REFUSED change show the truth instead of inverting every click after it.
   *
   * WHY THIS RETURNS A READING AND NOT NOTHING. The OFF path flushes the attic and THEN restores the
   * user's GSettings, including their workspace count: a flush that ran after the restore would have
   * moved windows onto workspaces that no longer exist. Nothing a client can poll afterwards can tell
   * those two orders apart, because by then Mutter has acted on the restored settings either way. These
   * two readings can: both are taken inside this one D-Bus call, so no main-loop turn separates them
   * from the flush, and `before.nWorkspaces === after.nWorkspaces === 2` with an empty attic in `after`
   * says the moves landed while the attic still existed. GSettings dispatches its `changed` signals from
   * the main loop, so the restore cannot have reached Mutter before `after` is read.
   */
  SetTiling(enabled: boolean): string {
    try {
      const before = this._readMutter();
      this._setTiling(enabled);
      return JSON.stringify({requested: enabled, before, after: this._readMutter()});
    } catch (error) {
      log.error(`SetTiling ${enabled} failed`, error);
      return JSON.stringify({error: String(error)});
    }
  }

  /**
   * Where Mutter -- not this extension -- says every window is.
   *
   * This exists because asking the extension whether it moved a window is circular. `GetWindows`
   * publishes `info.workspace` from the engine's own cache, and the question a toggle scenario asks is
   * precisely whether that cache agrees with the compositor: a scenario built on it would pass with every
   * single `moveToWorkspace` silently refused.
   *
   * TWO ENUMERATIONS, UNIONED, and the second one is not belt-and-braces. `get_tab_list` drops every
   * skip-taskbar window at the source (`meta_window_is_in_tab_chain` returns FALSE for one, for every
   * tab-list type), and a skip-taskbar window is one of the three things `Engine._flushAttic` exists to
   * rescue -- so a reader built on the tab list alone would report an empty attic for exactly the window
   * most likely to be stranded in it. `Meta.Workspace.list_windows()` has no such filter. `sources` says
   * which pass saw each window, so a failure shows whether a window was found only by the workspace walk.
   *
   * NORMAL_ALL, not NORMAL: `NORMAL` drops minimized windows, and a minimized window parked before it
   * was minimized is the other thing the flush exists to rescue.
   */
  MutterWindows(): string {
    try {
      return JSON.stringify(this._readMutter());
    } catch (error) {
      log.error('MutterWindows failed', error);
      return JSON.stringify({error: String(error)});
    }
  }

  /**
   * The Quick Settings switch as ST has it: its own `checked`, and the on-screen box a real click needs.
   *
   * `checked` is read off the widget, never off what this extension believes, because the one thing no
   * unit fake can answer is what GNOME 50's `St.Button` does with `checked` around its own `clicked`
   * emission -- the single assumption `src/shell/tilingToggle.ts` is built to survive either way.
   * `enabled` beside it is what the class last recorded from the engine, so a failure separates "the
   * engine never answered" from "the answer never reached the widget".
   */
  TilingToggleBox(): string {
    try {
      const menu = Main.panel.statusArea.quickSettings?.menu;
      return JSON.stringify({...this._toggle.debugState(), menuOpen: menu ? menu.isOpen : false});
    } catch (error) {
      log.error('TilingToggleBox failed', error);
      return JSON.stringify({error: String(error)});
    }
  }

  /**
   * Open or close the Quick Settings menu, with no animation.
   *
   * A quick toggle is unmapped and unclickable while the menu is shut, so this is the price of clicking
   * the real widget rather than calling into it. It is the ONLY part of the click that is synthesised:
   * the press itself goes through `ClickAt`'s virtual pointer and reaches `St.Button` as an ordinary
   * event, which is what makes the `clicked`-versus-`checked` ordering a measured fact for once.
   */
  QuickSettingsMenu(open: boolean): boolean {
    try {
      const quickSettings = Main.panel.statusArea.quickSettings;
      if (!quickSettings) {
        log.error('QuickSettingsMenu: this session mode has no quick settings');
        return false;
      }
      if (open)
        quickSettings.menu.open();
      else
        quickSettings.menu.close();
      return quickSettings.menu.isOpen === open;
    } catch (error) {
      log.error(`QuickSettingsMenu ${open} failed`, error);
      return false;
    }
  }

  /**
   * One real primary-button click at an absolute screen position.
   *
   * A virtual pointer device, not `St.Button.emit('clicked')` and not `WarpPointer` plus a synthetic
   * signal: the three events below enter Clutter's event queue in order on one device and are delivered
   * by the compositor, so whatever GNOME 50's click gesture does to `checked` relative to `clicked`
   * happens for real. That ordering is the one assumption `TilingToggle` cannot observe from inside, and
   * this project has shipped four defects that lived exactly where a fake answered for the compositor.
   *
   * `Clutter.BUTTON_PRIMARY`, not an evdev code: the virtual-device API takes Clutter button numbers and
   * each backend translates (the native backend to `BTN_LEFT`, the nested X11 one to X button 1).
   */
  ClickAt(x: number, y: number): boolean {
    try {
      this._pointer ??= Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
      const pointer = this._pointer;
      const now = (): number => GLib.get_monotonic_time();
      pointer.notify_absolute_motion(now(), Math.round(x), Math.round(y));
      pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
      pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
      return true;
    } catch (error) {
      log.error(`ClickAt ${x},${y} failed`, error);
      return false;
    }
  }

  private _readMutter(): MutterReading {
    const manager = global.workspace_manager;
    const order: Meta.Window[] = [];
    const sources = new Map<Meta.Window, string[]>();
    const mark = (window: Meta.Window, source: string): void => {
      const seen = sources.get(window);
      if (seen) {
        seen.push(source);
        return;
      }
      sources.set(window, [source]);
      order.push(window);
    };
    for (const window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null))
      mark(window, 'tabList');
    const nWorkspaces = manager.get_n_workspaces();
    for (let index = 0; index < nWorkspaces; index++) {
      const workspace = manager.get_workspace_by_index(index);
      if (!workspace) continue;
      for (const window of workspace.list_windows())
        mark(window, `workspace${index}`);
    }
    return {
      nWorkspaces,
      activeWorkspace: manager.get_active_workspace_index(),
      // Typed `any` by @girs (ui/main.d.ts); it is a plain number at runtime, and it is the Shell's own
      // count rather than anything the launcher remembers about its grab.
      modalCount: Number(Main.modalCount),
      windows: order.map(window => {
        // @girs types this non-nullable, as it does get_compositor_private(); Mutter returns null for a
        // window that is on no workspace, and -1 is out of band for every real index.
        const workspace = window.get_workspace() as Meta.Workspace | null;
        return {
          nativeId: window.get_id(),
          title: window.get_title() ?? '',
          workspace: workspace ? workspace.index() : -1,
          minimized: window.minimized,
          skipTaskbar: window.is_skip_taskbar(),
          sticky: window.is_on_all_workspaces(),
          sources: sources.get(window) ?? [],
        };
      }),
    };
  }

  SimulateSessionMode(locked: boolean): void {
    try {
      this._session.simulate(locked);
    } catch (error) {
      log.error('SimulateSessionMode failed', error);
    }
  }

  Relayout(): void {
    try {
      this._engine.relayout();
    } catch (error) {
      log.error('Relayout failed', error);
    }
  }

  LauncherState(): string {
    try {
      return JSON.stringify(this._launcher.debugState());
    } catch (error) {
      log.error('LauncherState failed', error);
      return '{}';
    }
  }

  /**
   * Put the real pointer at an absolute screen position.
   *
   * The two halves of `focus_follows_mouse` (rule 4, `Engine.onPointerOutput`) and `mouse_warping
   * output` (`Engine._warpToFocusedOutput`) are the only behaviours in this project that no unit fake
   * can stand in for: a fake pointer reports a crossing synchronously, where Mutter emits
   * `position-invalidated` on its own schedule and only for a position it accepts. This is how Task
   * 17's native scenarios cross an output boundary without a human hand. Test build only -- the
   * interface it is declared on is compiled out of a release bundle with `__I3SHELL_TEST__`.
   *
   * Deliberately does NOT go through `Pointer.warpTo`: that one takes a rect and aims at its centre,
   * which would make a scenario asserting "the pointer ended up inside this rect" compare the
   * production warp against itself. This names a bare coordinate the scenario chose.
   */
  WarpPointer(x: number, y: number): boolean {
    try {
      Clutter.get_default_backend().get_default_seat().warp_pointer(Math.round(x), Math.round(y));
      return true;
    } catch (error) {
      log.error(`WarpPointer ${x},${y} failed`, error);
      return false;
    }
  }

  /**
   * Where the pointer is now, in screen coordinates; `[-1, -1]` when Mutter will not say.
   *
   * Read from the cursor tracker rather than from anything this extension remembers, so a scenario
   * asserting that `focus output` warped the pointer is reading Mutter's own answer. The sentinel is
   * out of band for a real position (every work area here has non-negative origin), so a scenario
   * that gets it fails on the comparison rather than silently passing.
   */
  PointerPosition(): [number, number] {
    try {
      const [point] = global.backend.get_cursor_tracker().get_pointer();
      if (!point) return [-1, -1];
      return [Math.round(point.x), Math.round(point.y)];
    } catch (error) {
      log.error('PointerPosition failed', error);
      return [-1, -1];
    }
  }

  /**
   * Behave as if a three-finger touchpad swipe had completed in `direction` ("left" or "right").
   *
   * Enters at `Engine.onSwipe`, not at `Gestures`: the recogniser cannot be driven natively at all --
   * Mutter synthesises no touchpad events and the nested harness has no touchpad to produce them, so
   * `Clutter.VirtualInputDevice` (which `PressKey` uses for the keyboard) has nothing to offer here.
   * What that leaves genuinely coverable is everything downstream of the direction: the `bindgesture`
   * lookup, the command parse and the workspace switch it runs. That is the half worth a native
   * scenario, and the half a unit fake's `run()` cannot prove really moved a window on a real display.
   * Test build only, like the rest of this interface.
   */
  SimulateSwipe(direction: string): boolean {
    try {
      if (direction !== 'left' && direction !== 'right') {
        log.error(`SimulateSwipe: expected left or right, got "${direction}"`);
        return false;
      }
      this._engine.onSwipe(direction, global.get_current_time());
      return true;
    } catch (error) {
      log.error(`SimulateSwipe "${direction}" failed`, error);
      return false;
    }
  }

  PressKey(accel: string): boolean {
    try {
      const keyvals = accelToKeyvals(accel);
      if (!keyvals)
        return false;
      this._keyboard ??= Clutter.get_default_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
      const keyboard = this._keyboard;
      const now = () => GLib.get_monotonic_time();
      for (const keyval of keyvals)
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
      for (const keyval of [...keyvals].reverse())
        keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
      return true;
    } catch (error) {
      log.error(`PressKey "${accel}" failed`, error);
      return false;
    }
  }
}

export class DBusControl {
  private readonly _control: Gio.DBusExportedObject;
  private _debug: Gio.DBusExportedObject | null = null;
  private _ownerId = 0;
  private _unsubscribe: (() => void) | null = null;
  private _publishing = false;
  private _destroyed = false;
  private _nameLossHandled = false;

  constructor(engine: Engine, debug: DebugObject | null, notifyNameLoss: (title: string, body: string) => void) {
    const shellState = (): {actionMode: number; ready: boolean} => {
      // @girs/gnome-shell types Main.actionMode as literal NONE; Shell mutates it at runtime.
      const mode = Main.actionMode as Shell.ActionMode;
      return {
        actionMode: Number(mode),
        ready: (mode & (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)) !== 0,
      };
    };
    this._control = Gio.DBusExportedObject.wrapJSObject(CONTROL_IFACE,
      new ControlObject(engine, () => global.get_current_time(), shellState, log));
    try {
      this._control.export(Gio.DBus.session, OBJECT_PATH);
      // __I3SHELL_TEST__ is a compile-time literal, so release builds drop this branch and DEBUG_IFACE with it.
      if (__I3SHELL_TEST__ && debug !== null) {
        this._debug = Gio.DBusExportedObject.wrapJSObject(DEBUG_IFACE, debug);
        this._debug.export(Gio.DBus.session, OBJECT_PATH);
        log.info('test build: org.i3shell.Debug exported');
      }
      this._publishing = true;
      this._unsubscribe = engine.subscribeTreeChanged(guard('TreeChanged signal', () => {
        if (this._publishing)
          this._control.emit_signal('TreeChanged', new GLib.Variant('()', []));
      }));
      const nameLost = guard('D-Bus name loss', (_connection: Gio.DBusConnection | null, name: string) => {
        if (this._destroyed || this._nameLossHandled) return;
        this._nameLossHandled = true;
        this._stopPublishing(true);
        // A rival owner is an environmental condition we handle, not a
        // programming error: console.error would surface as a GNOME CRITICAL
        // and claim the extension had failed when only this optional control
        // surface is unavailable. The user is still notified once.
        log.warn(`D-Bus name ${name} was not acquired or was lost`);
        notifyNameLoss('i3-shell D-Bus unavailable', `${name} was not acquired; tiling and keybindings remain active`);
      });
      this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, nameLost);
    } catch (error) {
      this._stopPublishing(true);
      throw error;
    }
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopPublishing(true);
  }

  private _stopPublishing(releaseOwnership: boolean): void {
    this._publishing = false;
    const unsubscribe = this._unsubscribe;
    this._unsubscribe = null;
    if (unsubscribe) {
      try { unsubscribe(); } catch (error) { log.error('D-Bus tree unsubscribe failed', error); }
    }
    try { this._debug?.unexport(); } catch (error) { log.error('debug D-Bus unexport failed', error); }
    this._debug = null;
    try { this._control.unexport(); } catch (error) { log.error('control D-Bus unexport failed', error); }
    if (releaseOwnership && this._ownerId !== 0) {
      const ownerId = this._ownerId;
      this._ownerId = 0;
      try { Gio.bus_unown_name(ownerId); } catch (error) { log.error('D-Bus name release failed', error); }
    }
  }
}
