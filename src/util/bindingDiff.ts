import type {Binding} from '../config/model';

export interface BindingDiff {
  /** Accelerators to release. */
  ungrab: string[];
  /** Bindings to grab (new, or changed and released above). */
  grab: Binding[];
}

/** What to release and grab to go from `current` (accel → binding) to exactly `wanted`. */
export function diffBindings(current: Map<string, Binding>, wanted: Binding[]): BindingDiff {
  const wantedByAccel = new Map(wanted.map(b => [b.accel, b]));
  const ungrab: string[] = [];
  for (const [accel, existing] of current) {
    const w = wantedByAccel.get(accel);
    if (!w || w.command !== existing.command || w.noRepeat !== existing.noRepeat)
      ungrab.push(accel);
  }
  const released = new Set(ungrab);
  const grab = wanted.filter(b => !current.has(b.accel) || released.has(b.accel));
  return {ungrab, grab};
}
