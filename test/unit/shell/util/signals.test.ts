import {describe, expect, it} from 'vitest';
import {ClosingGate} from '../../../../src/shell/util/signals';

/**
 * Meta.Display::closing fires while the session tears down. Today every
 * compositor-signal handler in extension.ts keeps running after it, so a
 * handler still in flight can call geometry on a window being destroyed or
 * write to chrome the shell is disposing (the same defect shape Phase 2B
 * fixed once for the panel indicator, now multiplied by Phase 3A's borders,
 * frames, tab rows and bars).
 *
 * ClosingGate is the shared flag: rather than every consumer guarding
 * itself, extension.ts wraps each compositor-signal handler in
 * `unlessClosing`, and one `close()` call (from the `closing` signal) stops
 * all of them.
 */
describe('ClosingGate', () => {
  it('lets a wrapped handler run normally before close()', () => {
    const gate = new ClosingGate();
    const calls: number[] = [];
    const handler = gate.unlessClosing((n: number) => { calls.push(n); });

    handler(1);
    handler(2);

    expect(calls).toEqual([1, 2]);
    expect(gate.closing).toBe(false);
  });

  it('stops every handler it wraps once close() has run, from one shared flag', () => {
    const gate = new ClosingGate();
    const monitors: number[] = [];
    const workareas: number[] = [];
    // Two independently-wrapped handlers, standing in for monitors-changed
    // and workareas-changed: one close() call must silence both, which is
    // the whole point of a shared gate over guarding each consumer alone.
    const onMonitorsChanged = gate.unlessClosing(() => { monitors.push(1); });
    const onWorkareasChanged = gate.unlessClosing(() => { workareas.push(1); });

    onMonitorsChanged();
    gate.close();
    onMonitorsChanged();
    onWorkareasChanged();

    expect(monitors).toEqual([1]);
    expect(workareas).toEqual([]);
    expect(gate.closing).toBe(true);
  });

  it('forwards arguments through to the wrapped handler', () => {
    const gate = new ClosingGate();
    let seen: [string, number] | null = null;
    const handler = gate.unlessClosing((a: string, b: number) => { seen = [a, b]; });

    handler('x', 2);

    expect(seen).toEqual(['x', 2]);
  });
});
