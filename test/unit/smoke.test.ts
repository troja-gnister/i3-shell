import {describe, it, expect} from 'vitest';

describe('toolchain smoke', () => {
  it('runs TypeScript tests on Node', () => {
    const sum = [1, 2, 3].reduce((a, b) => a + b, 0);
    expect(sum).toBe(6);
  });
});
