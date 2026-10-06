import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {guard} from './util/signals';

/**
 * The "Tiling" switch in GNOME's Quick Settings.
 *
 * It cannot be "disable the extension": the switch would go away with it and there would be no way back
 * on. So it drives `Engine.setTilingEnabled` instead, which pauses the engine and flushes the attic while
 * leaving every object -- including this one -- alive.
 *
 * Teardown follows `src/shell/indicator.ts` exactly, and for the same reason: at shutdown the shell
 * destroys the panel, and everything in it, BEFORE `disable()` runs, and GJS then logs a critical for
 * every property written to a disposed actor. The toggle's own `destroy` signal sets `_destroyed`, and
 * every method returns early on it. There is ONE teardown route -- `destroy()`, called from
 * `disable()` -- and no second one: the actors are not registered with the SignalTracker and nothing else
 * destroys them.
 *
 * `addExternalIndicator` is the documented way for an extension to put an item in Quick Settings
 * (`node_modules/@girs/gnome-shell/dist/ui/panel.d.ts:72`). `statusArea.quickSettings` is typed optional
 * there, and that is not pedantry: a session mode that builds no quick settings would otherwise take
 * `enable()` down with it, and `enable()` is the one path that has to work when everything else failed.
 */
export class TilingToggle {
  private readonly _indicator = new QuickSettings.SystemIndicator();
  private readonly _toggle = new QuickSettings.QuickToggle({
    title: 'Tiling',
    iconName: 'view-grid-symbolic',
    toggleMode: true,
    checked: true,
  });
  /** The shell destroys the panel before disable() runs; see the class comment. */
  private _destroyed = false;

  constructor(onChanged: (enabled: boolean) => void) {
    // `clicked` arrives AFTER St.Button has flipped `checked` (the toggle is in toggleMode), so the
    // actor's own state is the answer. A local boolean mirrored here would drift the first time
    // `setChecked` or anything else moved the actor.
    this._toggle.connect('clicked', guard('tiling toggle', () => { onChanged(this._toggle.checked); }));
    this._toggle.connect('destroy', guard('tiling toggle destroy', () => { this._destroyed = true; }));
    this._indicator.quickSettingsItems.push(this._toggle);
    Main.panel.statusArea.quickSettings?.addExternalIndicator(this._indicator);
  }

  /** Moves the switch without firing `clicked`, for a state change the user did not make. */
  setChecked(enabled: boolean): void {
    if (this._destroyed) return;
    if (this._toggle.checked !== enabled) this._toggle.checked = enabled;
  }

  destroy(): void {
    if (this._destroyed) return;
    this._toggle.destroy();
    this._indicator.destroy();
  }
}
