import St from 'gi://St';
import type {Accent} from '../config/colors';

/** `53` -> `"35"`. Cogl reports each component as a 0-255 byte, not a 0-1 float. */
function hex(component: number): string {
  return Math.max(0, Math.min(255, Math.round(component))).toString(16).padStart(2, '0');
}

/**
 * The desktop accent colour, and changes to it.
 *
 * `St.ThemeContext.get_accent_color()` hands back the resolved pair rather than
 * the `St.Settings` enum, so a distro that retunes the palette is followed
 * without this file carrying a copy of it. The components are bytes: a live
 * nested shell reports GNOME's blue as 53,132,228, which is #3584e4.
 */
export class ShellAccent {
  private _settings = St.Settings.get();
  private _handler: number | null = null;

  current(): Accent | null {
    const [accent, foreground] = St.ThemeContext.get_for_stage(global.stage).get_accent_color();
    if (!accent || !foreground) return null;
    return {
      background: `#${hex(accent.red)}${hex(accent.green)}${hex(accent.blue)}`,
      text: `#${hex(foreground.red)}${hex(foreground.green)}${hex(foreground.blue)}`,
    };
  }

  subscribe(callback: () => void): void {
    if (this._handler !== null) return;
    this._handler = this._settings.connect('notify::accent-color', () => callback());
  }

  destroy(): void {
    if (this._handler === null) return;
    this._settings.disconnect(this._handler);
    this._handler = null;
  }
}
