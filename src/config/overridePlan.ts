import type {Config} from './model';

export interface OverridePlan {
  /** Default-mode accelerators; any GNOME binding equal to one of these is cleared. */
  accels: string[];
  /** 0 = leave GNOME's workspace count alone. */
  workspaceCount: number;
  /** Value for org.gnome.desktop.wm.preferences mouse-button-modifier ('' disables). */
  mouseButtonModifier: string;
  /**
   * Value for org.gnome.desktop.wm.preferences focus-mode. 'sloppy' is Mutter's own
   * focus-follows-mouse, with i3's semantics; 'click' is GNOME's ordinary click-to-focus.
   */
  focusMode: 'sloppy' | 'click';
}

export function planOverrides(config: Config): OverridePlan {
  const accels = config.modes.get('default')?.bindings.map(b => b.accel) ?? [];
  const mouseButtonModifier =
    config.floatingModifier === 'Mod4' ? '<Super>' :
    config.floatingModifier === 'Mod1' ? '<Alt>' : '';
  const focusMode = config.focusFollowsMouse ? 'sloppy' : 'click';
  return {accels, workspaceCount: config.workspaceCount, mouseButtonModifier, focusMode};
}
