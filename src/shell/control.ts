import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {parseCommands} from '../commands/parse';
import type {Engine} from '../engine';
import {log} from './log';
import type {SessionWatcher} from './session';

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
  </interface>
</node>`;

const DEBUG_IFACE = `<node>
  <interface name="org.i3shell.Debug">
    <method name="SimulateSessionMode"><arg type="b" direction="in" name="locked"/></method>
    <method name="PressKey">
      <arg type="s" direction="in" name="accel"/>
      <arg type="b" direction="out" name="ok"/>
    </method>
  </interface>
</node>`;

/** The i3-msg equivalent: `gdbus call --session --dest org.i3shell.Control --object-path /org/i3shell/Control --method org.i3shell.Control.Command "workspace number 3"` */
class ControlObject {
  constructor(private readonly _engine: Engine) {}

  Command(command: string): [boolean, string] {
    const {commands, diagnostics} = parseCommands(command);
    if (diagnostics.length > 0)
      return [false, diagnostics.join('; ')];
    try {
      return [true, this._engine.run(commands, global.get_current_time())];
    } catch (e) {
      log.error(`Command "${command}" failed`, e);
      return [false, String(e)];
    }
  }

  GetState(): string {
    // gnome-shell enables extensions before its `startup-complete` handler sets the action mode, and a
    // window-less session rests in the overview (OVERVIEW, value 2); keybindings only fire once the mode
    // is NORMAL or OVERVIEW. @girs/gnome-shell mistypes Main.actionMode as the literal NONE, hence the cast.
    const actionMode = Number(Main.actionMode as Shell.ActionMode);
    const ready = ((Main.actionMode as Shell.ActionMode) & (Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW)) !== 0;
    return JSON.stringify({...this._engine.state(), actionMode, ready});
  }

  GetConfigStatus(): string {
    const loaded = this._engine.lastLoad;
    return JSON.stringify({
      path: loaded.path,
      source: loaded.source,
      errors: loaded.diagnostics.filter(d => d.severity === 'error').length,
      warnings: loaded.diagnostics.filter(d => d.severity === 'warning').length,
      diagnostics: loaded.diagnostics,
    });
  }
}

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

  constructor(private readonly _session: SessionWatcher) {}

  SimulateSessionMode(locked: boolean): void {
    this._session.simulate(locked);
  }

  PressKey(accel: string): boolean {
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
  }
}

export class DBusControl {
  private readonly _control: Gio.DBusExportedObject;
  private readonly _debug: Gio.DBusExportedObject | null = null;
  private readonly _ownerId: number;

  constructor(engine: Engine, debug: DebugObject | null) {
    this._control = Gio.DBusExportedObject.wrapJSObject(CONTROL_IFACE, new ControlObject(engine));
    this._control.export(Gio.DBus.session, OBJECT_PATH);
    // __I3SHELL_TEST__ is a compile-time literal, so release builds drop this branch and DEBUG_IFACE with it
    if (__I3SHELL_TEST__ && debug !== null) {
      this._debug = Gio.DBusExportedObject.wrapJSObject(DEBUG_IFACE, debug);
      this._debug.export(Gio.DBus.session, OBJECT_PATH);
      log.info('test build: org.i3shell.Debug exported');
    }
    this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
  }

  destroy(): void {
    this._control.unexport();
    this._debug?.unexport();
    Gio.bus_unown_name(this._ownerId);
  }
}
