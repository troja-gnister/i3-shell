import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TAG = '[i3-shell] SMOKE';

function signalNames(gtype: GObject.GType): string[] {
  return GObject.signal_list_ids(gtype).map(id => GObject.signal_name(id) ?? '');
}

/** Verifies, inside a running shell, the two facts the design relies on but introspection cannot show. */
export function runSmoke(): void {
  const hasActivated = signalNames(Meta.Display.$gtype).includes('accelerator-activated');
  const hasFirstFrame = signalNames(Meta.WindowActor.$gtype).includes('first-frame');
  console.log(`${TAG} signals: accelerator-activated=${hasActivated} first-frame=${hasFirstFrame}`);

  const action = global.display.grab_accelerator('<Super>F12', Meta.KeyBindingFlags.NONE);
  console.log(`${TAG} grab <Super>F12 -> action ${action}`);
  if (action === Meta.KeyBindingAction.NONE) {
    console.log(`${TAG} FAIL grab_accelerator returned NONE`);
    return;
  }
  Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action),
    Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);

  let fired = false;
  const signalId = global.display.connect('accelerator-activated',
    (_display: Meta.Display, activated: number) => {
      if (activated === action) {
        fired = true;
        console.log(`${TAG} accelerator-activated fired`);
      }
    });

  const ALLOWED = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
  let tries = 0;
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
    if (((Main.actionMode as Shell.ActionMode) & ALLOWED) === 0) {
      if (++tries < 60)
        return GLib.SOURCE_CONTINUE;
      console.log(`${TAG} FAIL (actionMode never NORMAL/OVERVIEW; last=${Main.actionMode})`);
      return GLib.SOURCE_REMOVE;
    }
    console.log(`${TAG} actionMode=${Main.actionMode} sessionMode=${Main.sessionMode.currentMode}`);
    const seat = Clutter.get_default_backend().get_default_seat();
    const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const now = () => GLib.get_monotonic_time();
    keyboard.notify_keyval(now(), Clutter.KEY_Super_L, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_F12, Clutter.KeyState.PRESSED);
    keyboard.notify_keyval(now(), Clutter.KEY_F12, Clutter.KeyState.RELEASED);
    keyboard.notify_keyval(now(), Clutter.KEY_Super_L, Clutter.KeyState.RELEASED);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
      const ok = fired && hasActivated && hasFirstFrame;
      console.log(`${TAG} ${ok ? 'ok' : 'FAIL'} (fired=${fired})`);
      global.display.disconnect(signalId);
      global.display.ungrab_accelerator(action);
      return GLib.SOURCE_REMOVE;
    });
    return GLib.SOURCE_REMOVE;
  });
}
