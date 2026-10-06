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
 * It does NOT ask for `toggleMode`, and it never reads the widget's own `checked` to decide anything. Both
 * are fix round 1, I3. In toggle mode St.Button flips `checked` itself around the `clicked` signal, and
 * whether it does so before or after emitting is a fact about compositor C code that nothing in this repo
 * can observe -- while this project has four times been bitten by an assumption about compositor behaviour
 * that only a fake confirmed. Reading `checked` is correct under one order and catastrophic under the
 * other: every request would come out equal to the engine's current state, `setTilingEnabled`'s no-change
 * early return would fire, and the switch would be permanently inert while still animating under the
 * user's finger -- a control that looks like it works and does nothing.
 *
 * So the engine's state is the only input: a click asks for its opposite, and the switch's appearance is
 * written from the answer that comes back through `setChecked`. With no `toggleMode` the widget never
 * writes `checked` on its own schedule, so there is no order left to be wrong about, and nothing is lost
 * visually: GNOME 50's own theme draws a quick toggle "on" purely from the `:checked` pseudo-class, which
 * follows the property this class sets (`gnome-shell-dark.css`: `.quick-toggle:checked`).
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
    checked: true,
  });
  /** The shell destroys the panel before disable() runs; see the class comment. */
  private _destroyed = false;
  /**
   * What the ENGINE is doing, as last reported through `setChecked`. The widget's `checked` is this
   * class's output, never its input; see the class comment for what reading it back would cost. True to
   * start, matching both the `checked: true` above and `Engine.tilingEnabled` on a fresh enable.
   */
  private _enabled = true;

  constructor(onChanged: (enabled: boolean) => void) {
    // A click asks for the opposite of what the engine is doing -- which is what the user who clicked a
    // switch means, whatever the widget has done with its own appearance by the time this runs. The answer
    // arrives back through `setChecked`, and only that moves `_enabled`: recording the REQUEST here would
    // make a refused change look accepted and send the next click the wrong way.
    this._toggle.connect('clicked', guard('tiling toggle', () => { onChanged(!this._enabled); }));
    this._toggle.connect('destroy', guard('tiling toggle destroy', () => { this._destroyed = true; }));
    this._indicator.quickSettingsItems.push(this._toggle);
    Main.panel.statusArea.quickSettings?.addExternalIndicator(this._indicator);
  }

  /**
   * What the engine is now doing, which is both the switch's appearance and the state the next click is
   * measured against. Called by `src/extension.ts` after every `setTilingEnabled`, including the ones the
   * engine refuses -- that is what makes a refusal snap the switch back instead of leaving it lying.
   */
  setChecked(enabled: boolean): void {
    this._enabled = enabled;
    if (this._destroyed) return;
    if (this._toggle.checked !== enabled) this._toggle.checked = enabled;
  }

  /**
   * What ST has, for the native scenarios: the widget's own `checked`, this class's record of the
   * engine's answer, and the on-screen box a real click has to land in.
   *
   * `checked` and `enabled` are reported SEPARATELY on purpose. They are the two halves of the one
   * assumption this class is built to survive -- whether GNOME flips `checked` before or after it emits
   * `clicked` -- so a native failure that shows them disagreeing names which half broke, where a single
   * "is it on" would only say that something did.
   *
   * The box is in stage coordinates (`get_transformed_position`), which is what the compositor wants
   * back when it is asked to put a pointer there; `width`/`height` are 0 and `mapped` false while the
   * Quick Settings menu is shut, which is why `Debug.QuickSettingsMenu` exists.
   *
   * Reads nothing at all once the shell has destroyed the panel: every member access on a disposed
   * actor is a GJS critical, and the nested harness fails the run on one.
   */
  debugState(): {checked: boolean; enabled: boolean; mapped: boolean;
    x: number; y: number; width: number; height: number} {
    if (this._destroyed)
      return {checked: false, enabled: this._enabled, mapped: false, x: -1, y: -1, width: -1, height: -1};
    const [x, y] = this._toggle.get_transformed_position();
    const [width, height] = this._toggle.get_transformed_size();
    return {
      checked: this._toggle.checked,
      enabled: this._enabled,
      mapped: this._toggle.mapped,
      x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height),
    };
  }

  destroy(): void {
    if (this._destroyed) return;
    this._toggle.destroy();
    this._indicator.destroy();
  }
}
