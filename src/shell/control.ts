import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Engine} from '../engine';
import {ControlObject} from './controlObject';
import {log} from './log';
import type {SessionWatcher} from './session';
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

/** Test-build only: lets the integration harness press keys and fake the lock screen. */
export class DebugObject {
  private _keyboard: Clutter.VirtualInputDevice | null = null;

  constructor(private readonly _session: SessionWatcher, private readonly _engine: Engine) {}

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
