import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {SessionState} from './sessionState';
import type {SignalTracker} from './util/signals';

/**
 * Fires once per lock/unlock edge. The extension stays enabled across locking
 * (session-modes includes unlock-dialog), so grabs must be released here (§8.4 item 6).
 */
export class SessionWatcher {
  private readonly _state: SessionState;

  constructor(tracker: SignalTracker, onLocked: () => void, onUnlocked: () => void) {
    this._state = new SessionState(Main.sessionMode.isLocked || !Main.sessionMode.hasWindows, onLocked, onUnlocked);
    tracker.connect(Main.sessionMode, 'updated', () =>
      this._state.update(Main.sessionMode.isLocked || !Main.sessionMode.hasWindows));
  }

  get isLocked(): boolean {
    return this._state.isLocked;
  }

  /** Test hook for org.i3shell.Debug: behave as if the session locked/unlocked. */
  simulate(locked: boolean): void {
    this._state.update(locked);
  }
}
