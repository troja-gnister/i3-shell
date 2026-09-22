import {describe, expect, it} from 'vitest';
import {SmoothScroll} from '../../../src/util/smoothScroll';

describe('SmoothScroll', () => {
  it('accumulates movement and preserves the signed fractional remainder', () => {
    const scroll = new SmoothScroll();
    expect(scroll.push(0.4)).toEqual([]);
    expect(scroll.push(0.7)).toEqual(['next']);
    expect(scroll.push(-1.2)).toEqual(['prev']);
  });

  it('emits one action for every whole unit', () => {
    const scroll = new SmoothScroll();
    expect(scroll.push(2.7)).toEqual(['next', 'next']);
    expect(scroll.push(-4.2)).toEqual(['prev', 'prev', 'prev']);
  });

  it('treats horizontal-only and nonfinite deltas as no vertical action', () => {
    const scroll = new SmoothScroll();
    expect(scroll.push(0)).toEqual([]);
    expect(scroll.push(0.7)).toEqual([]);
    expect(scroll.push(Number.NaN)).toEqual([]);
    expect(scroll.push(Number.POSITIVE_INFINITY)).toEqual([]);
    expect(scroll.push(0.4)).toEqual(['next']);
  });

  it('reset clears accumulated movement', () => {
    const scroll = new SmoothScroll();
    expect(scroll.push(0.7)).toEqual([]);
    scroll.reset();
    expect(scroll.push(0.4)).toEqual([]);
  });
});
