import type {Config} from './model';

export interface OverridePlan {
  /** Default-mode accelerators; any GNOME binding equal to one of these is cleared. */
  accels: string[];
  /** 0 = leave GNOME's workspace count alone. */
  workspaceCount: number;
  workspaceNames: string[];
  /** Value for org.gnome.desktop.wm.preferences mouse-button-modifier ('' disables). */
  mouseButtonModifier: string;
}

export function planOverrides(config: Config): OverridePlan {
  const accels = config.modes.get('default')?.bindings.map(b => b.accel) ?? [];
  const workspaceNames: string[] = [];
  for (let n = 1; n <= config.workspaceCount; n++)
    workspaceNames.push(config.workspaceNames.get(n) ?? String(n));
  const mouseButtonModifier =
    config.floatingModifier === 'Mod4' ? '<Super>' :
    config.floatingModifier === 'Mod1' ? '<Alt>' : '';
  return {accels, workspaceCount: config.workspaceCount, workspaceNames, mouseButtonModifier};
}
