import {describe, expect, it} from 'vitest';
import {fixFloatingCoordinates} from '../../../src/tree/floating';

/**
 * i3's own rule (src/floating.c, floating_fix_coordinates): a floating window that changes output keeps
 * its SIZE, and its CENTRE keeps the same fraction of the work area it had on the output it left. The
 * one divergence is the clamp -- see the doc comment on the function.
 *
 * Every fixture here gives the two work areas DIFFERENT WIDTHS AND HEIGHTS on purpose. With two equal
 * areas, "scale the centre fraction" and the much simpler "add the difference of the origins" produce
 * the same answer for every input, and the whole test file would pass against the wrong rule.
 */
describe('fixFloatingCoordinates', () => {
  const WIDE = {x: 0, y: 0, width: 1920, height: 1080};
  const NARROW = {x: 1920, y: 0, width: 1280, height: 720};

  it('keeps the size and the centre fraction when the two outputs differ in size', () => {
    // Centre at x = 1440 (75% of 1920) and y = 540 (50% of 1080).
    const moved = fixFloatingCoordinates({x: 1340, y: 490, width: 200, height: 100}, WIDE, NARROW);
    // 75% of 1280 is 960, plus the destination origin 1920, less half the width.
    expect(moved).toEqual({x: 2780, y: 310, width: 200, height: 100});
  });

  it('is the identity on position when the window is centred and the aspect is kept', () => {
    const centred = {x: 860, y: 490, width: 200, height: 100};
    const moved = fixFloatingCoordinates(centred, WIDE, WIDE);
    expect(moved).toEqual(centred);
  });

  it('pins a window wider than the destination to the destination left edge', () => {
    // Review Focus 2. 1600 wide will not fit in 1280; i3 would leave it hanging off both sides.
    const moved = fixFloatingCoordinates({x: 100, y: 100, width: 1600, height: 400}, WIDE, NARROW);
    expect(moved.x).toBe(NARROW.x);
    expect(moved.width).toBe(1600);
  });

  it('pins a window taller than the destination to the destination top edge', () => {
    // Review Focus 2, the other axis: the one that puts a title bar out of reach.
    const moved = fixFloatingCoordinates({x: 100, y: 100, width: 300, height: 900}, WIDE, NARROW);
    expect(moved.y).toBe(NARROW.y);
    expect(moved.height).toBe(900);
  });

  it('keeps a window that would overhang the far edge fully inside the destination', () => {
    // Centre at 95% of 1920; 95% of 1280 is 1216, which would put the right edge past 3200.
    const moved = fixFloatingCoordinates({x: 1724, y: 1000, width: 400, height: 200}, WIDE, NARROW);
    expect(moved.x).toBe(NARROW.x + NARROW.width - 400);
    expect(moved.y).toBe(NARROW.y + NARROW.height - 200);
  });

  it('centres on the destination when the source work area has no extent to scale against', () => {
    const moved = fixFloatingCoordinates(
      {x: 0, y: 0, width: 200, height: 100}, {x: 0, y: 0, width: 0, height: 0}, NARROW);
    expect(moved).toEqual({x: 2460, y: 310, width: 200, height: 100});
  });
});
