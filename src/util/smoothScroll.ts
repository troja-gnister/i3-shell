export type ScrollAction = 'next' | 'prev';

/** Converts smooth vertical scroll deltas into whole workspace steps. */
export class SmoothScroll {
  private _remainder = 0;

  push(deltaY: number): ScrollAction[] {
    if (!Number.isFinite(deltaY))
      return [];

    const total = this._remainder + deltaY;
    const units = Math.trunc(total);
    this._remainder = total - units;
    return Array.from<ScrollAction>({length: Math.abs(units)}).fill(units > 0 ? 'next' : 'prev');
  }

  reset(): void {
    this._remainder = 0;
  }
}
