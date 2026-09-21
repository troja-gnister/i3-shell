import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {Binding} from '../config/model';
import {diffBindings} from '../util/bindingDiff';
import {log} from './log';
import type {SignalTracker} from './util/signals';

export interface GrabReport {
  /** Bindings whose grab failed on the first attempt; they are retried once after RETRY_MS. */
  failed: Binding[];
}

export interface KeyBinderPort {
  setBindings(bindings: Binding[]): GrabReport;
  ungrabAll(): void;
  readonly grabbedCount: number;
}

/** Grabbed accelerators fire in normal desktop use and in the overview; the lock screen is handled by ungrabbing (§8.4 item 6). */
const ALLOWED_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
const RETRY_MS = 500;

/**
 * Owns the set of currently grabbed accelerators. `setBindings()` makes exactly the given set
 * active (mode switches call it with the new mode's bindings). Dispatches `accelerator-activated`.
 */
export class KeyBinder implements KeyBinderPort {
  private readonly _byAction = new Map<number, Binding>();
  private readonly _byAccel = new Map<string, {action: number; binding: Binding}>();
  private _pending: Binding[] = [];
  private _retryId = 0;

  constructor(tracker: SignalTracker, private readonly _onActivate: (binding: Binding, timestamp: number) => void) {
    tracker.connect(global.display, 'accelerator-activated',
      (_display: Meta.Display, action: number, _device: unknown, timestamp: number) => {
        const binding = this._byAction.get(action);
        if (binding)
          this._onActivate(binding, timestamp);
      });
  }

  get grabbedCount(): number {
    return this._byAccel.size;
  }

  setBindings(bindings: Binding[]): GrabReport {
    this._cancelRetry();
    const current = new Map([...this._byAccel].map(([accel, entry]) => [accel, entry.binding]));
    const diff = diffBindings(current, bindings);
    for (const accel of diff.ungrab)
      this._ungrab(accel);
    const failed: Binding[] = [];
    for (const binding of diff.grab) {
      if (!this._grab(binding))
        failed.push(binding);
    }
    if (failed.length > 0)
      this._scheduleRetry(failed);
    return {failed};
  }

  ungrabAll(): void {
    this._cancelRetry();
    for (const accel of [...this._byAccel.keys()])
      this._ungrab(accel);
  }

  destroy(): void {
    this.ungrabAll();
  }

  private _grab(binding: Binding): boolean {
    const flags = binding.noRepeat ? Meta.KeyBindingFlags.IGNORE_AUTOREPEAT : Meta.KeyBindingFlags.NONE;
    const action = global.display.grab_accelerator(binding.accel, flags);
    if (action === Meta.KeyBindingAction.NONE)
      return false;
    // Without this the shell's keybinding filter drops the action (see shellDBus.js GrabAccelerator).
    Main.wm.allowKeybinding(Meta.external_binding_name_for_action(action), ALLOWED_MODES);
    this._byAction.set(action, binding);
    this._byAccel.set(binding.accel, {action, binding});
    return true;
  }

  private _ungrab(accel: string): void {
    const entry = this._byAccel.get(accel);
    if (!entry)
      return;
    this._byAccel.delete(accel);
    this._byAction.delete(entry.action);
    if (!global.display.ungrab_accelerator(entry.action))
      log.warn(`ungrab failed for ${accel}`);
  }

  /** gsd-media-keys may still hold an accelerator we just cleared from its settings; try once more shortly after. */
  private _scheduleRetry(failed: Binding[]): void {
    this._pending = failed;
    this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETRY_MS, () => {
      this._retryId = 0;
      const pending = this._pending;
      this._pending = [];
      for (const binding of pending) {
        if (this._byAccel.has(binding.accel))
          continue;
        if (!this._grab(binding))
          log.warn(`could not grab ${binding.combo} (${binding.accel}): another client holds it`);
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private _cancelRetry(): void {
    if (this._retryId !== 0) {
      GLib.source_remove(this._retryId);
      this._retryId = 0;
    }
    this._pending = [];
  }
}
