/** Pure lock-edge state used by the native session watcher and unit tests. */
export class SessionState {
  constructor(
    private _locked: boolean,
    private readonly _onLocked: () => void,
    private readonly _onUnlocked: () => void,
  ) {}

  get isLocked(): boolean {
    return this._locked;
  }

  update(locked: boolean): void {
    if (locked === this._locked)
      return;
    this._locked = locked;
    if (locked)
      this._onLocked();
    else
      this._onUnlocked();
  }
}
