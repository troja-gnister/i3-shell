import {describe, expect, it} from 'vitest';
import {RectReconciler} from '../../../src/runtime/reconcile';

describe('RectReconciler', () => {
  it('allows only one correction for each expected-rectangle generation', () => {
    const r = new RectReconciler();
    const a = {x: 0, y: 30, width: 500, height: 700};
    const wrong = {...a, width: 640};

    expect(r.plan(new Map([[1, a]]), new Set())).toEqual(new Map([[1, a]]));
    const g = r.generation(1)!;
    expect(r.observe(1, a, g)).toBe(false);
    expect(r.observe(1, wrong, g)).toBe(true);
    expect(r.observe(1, wrong, g)).toBe(false);
    expect(r.plan(new Map([[1, a]]), new Set())).toEqual(new Map([[1, a]]));
    expect(r.observe(1, wrong, g)).toBe(false);
    expect(r.status(1)?.stubborn).toBe(true);
    expect(r.plan(new Map([[1, a]]), new Set())).toEqual(new Map());
    expect(r.plan(new Map([[1, a]]), new Set([1]))).toEqual(new Map([[1, a]]));
    const forcedGeneration = r.generation(1)!;
    expect(forcedGeneration).not.toBe(g);
    expect(r.observe(1, wrong, g)).toBe(false);
    expect(r.observe(1, wrong, forcedGeneration)).toBe(true);
  });

  it('starts a fresh correction budget only when the target value changes', () => {
    const r = new RectReconciler();
    const first = {x: 10, y: 20, width: 300, height: 400};
    const wrong = {...first, x: 11};
    r.plan(new Map([[4, first]]), new Set());
    const firstGeneration = r.generation(4)!;
    expect(r.observe(4, wrong, firstGeneration)).toBe(true);
    r.plan(new Map([[4, {...first}]]), new Set());

    expect(r.generation(4)).toBe(firstGeneration);
    expect(r.observe(4, wrong, firstGeneration)).toBe(false);
    expect(r.status(4)?.stubborn).toBe(true);

    const changed = {...first, height: 401};
    expect(r.plan(new Map([[4, changed]]), new Set())).toEqual(new Map([[4, changed]]));
    const changedGeneration = r.generation(4)!;
    expect(changedGeneration).not.toBe(firstGeneration);
    expect(r.observe(4, {...changed, x: 12}, changedGeneration)).toBe(true);
  });

  it('coalesces duplicate mismatches and cancels a queued correction on a matching observation', () => {
    const r = new RectReconciler();
    const expected = {x: -1200, y: 0, width: 1200, height: 800};
    const wrong = {...expected, y: 1};
    r.plan(new Map([[8, expected]]), new Set());
    const generation = r.generation(8)!;

    expect(r.observe(8, wrong, generation)).toBe(true);
    expect(r.observe(8, wrong, generation)).toBe(false);
    expect(r.observe(8, {...expected}, generation)).toBe(false);
    expect(r.plan(new Map([[8, expected]]), new Set())).toEqual(new Map());
    expect(r.observe(8, wrong, generation)).toBe(true);
  });

  it('does not restore a consumed retry when the observed frame later matches', () => {
    const r = new RectReconciler();
    const expected = {x: 0, y: 0, width: 800, height: 600};
    const wrong = {...expected, width: 801};
    r.plan(new Map([[2, expected]]), new Set());
    const generation = r.generation(2)!;
    r.observe(2, wrong, generation);
    r.plan(new Map([[2, expected]]), new Set());

    expect(r.observe(2, expected, generation)).toBe(false);
    expect(r.observe(2, wrong, generation)).toBe(false);
    expect(r.status(2)).toMatchObject({retried: true, stubborn: true});
  });

  it('suspends omitted fullscreen or minimized targets and explicitly forgets removed ids', () => {
    const r = new RectReconciler();
    const expected = {x: 0, y: 24, width: 900, height: 700};
    r.plan(new Map([[3, expected]]), new Set());
    const generation = r.generation(3)!;

    expect(r.plan(new Map(), new Set())).toEqual(new Map());
    expect(r.generation(3)).toBe(generation);
    expect(r.plan(new Map([[3, {...expected}]]), new Set())).toEqual(new Map());
    expect(r.generation(3)).toBe(generation);

    r.forget(3);
    expect(r.status(3)).toBeUndefined();
    expect(r.plan(new Map([[3, expected]]), new Set())).toEqual(new Map([[3, expected]]));
    expect(r.generation(3)).not.toBe(generation);

    r.clear();
    expect(r.status(3)).toBeUndefined();
  });
});
