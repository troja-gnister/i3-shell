import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type {SignalTracker} from './util/signals';

/**
 * Fires once per lock/unlock edge. The extension stays enabled across locking
 * (session-modes includes unlock-dialog), so grabs must be released here (§8.4 item 6).
 */
export class SessionWatcher {
  private _locked: boolean;

  constructor(tracker: SignalTracker, private readonly _onLocked: () => void, private readonly _onUnlocked: () => void) {
    this._locked = Main.sessionMode.isLocked;
    tracker.connect(Main.sessionMode, 'updated', () => this._update(Main.sessionMode.isLocked));
  }

  get isLocked(): boolean {
    return this._locked;
  }

  /** Test hook for org.i3shell.Debug: behave as if the session locked/unlocked. */
  simulate(locked: boolean): void {
    this._update(locked);
  }

  private _update(locked: boolean): void {
    if (locked === this._locked)
      return;
    this._locked = locked;
    if (locked)
      this._onLocked();
    else
      this._onUnlocked();
  }
}
