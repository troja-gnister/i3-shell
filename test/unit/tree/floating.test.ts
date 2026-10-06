import {describe, expect, it} from 'vitest';
import {fixFloatingCoordinates, originWithin} from '../../../src/tree/floating';

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

/**
 * `originWithin` is the idempotency test `Engine._followFloatingFrames` needs: the pass runs on every
 * commit, and the compositor does not report the window's new monitor until some later one, so without a
 * way to recognise a frame it has ALREADY translated it would translate it again on each commit in
 * between -- and because the result is clamped, each pass drags the window further into the destination's
 * far corner. (Measured, before this existed: the first commit wrote the right rect, x=2780, and the very
 * next one wrote x=3000, the clamp's limit.)
 */
describe('originWithin', () => {
  const WIDE = {x: 0, y: 0, width: 1920, height: 1080};
  const NARROW = {x: 1920, y: 0, width: 1280, height: 720};

  it('is false for a frame still sitting on the output its workspace left', () => {
    expect(originWithin({x: 1340, y: 490, width: 200, height: 100}, NARROW)).toBe(false);
  });

  it('is true for every frame fixFloatingCoordinates produces, which is what makes the pass a fixed point', () => {
    // Four sources, because the postcondition has to hold for all of them or the engine pass translates
    // some window forever: one ordinary, one in the far corner (pinned by the upper clamp), one the
    // compositor reports OUTSIDE its own work area -- a window dragged off the edge, which gives a
    // fraction above 1 -- and one larger than the destination (pinned by the lower clamp).
    for (const source of [{x: 1340, y: 490, width: 200, height: 100},
      {x: 1724, y: 1000, width: 400, height: 200},
      {x: 5000, y: 3000, width: 200, height: 100},
      {x: 100, y: 100, width: 4000, height: 3000}]) {
      const moved = fixFloatingCoordinates(source, WIDE, NARROW);
      expect(originWithin(moved, NARROW), JSON.stringify({source, moved})).toBe(true);
    }
  });

  it('holds as a postcondition even for a window larger than the destination on both axes', () => {
    // The case the clamp exists for, and the one an `originWithin` using the window's far edge or its
    // centre would get wrong -- leaving the pass re-translating an oversized window forever.
    const moved = fixFloatingCoordinates({x: 100, y: 100, width: 4000, height: 3000}, WIDE, NARROW);
    expect(originWithin(moved, NARROW)).toBe(true);
  });

  it('is false for a frame straddling the boundary from the output it is leaving', () => {
    // A window the compositor has already handed to NARROW but whose corner is still over WIDE: not yet
    // translated by this rule, which is what lets the monitor guard rather than this one decide it.
    expect(originWithin({x: 1850, y: 100, width: 200, height: 100}, NARROW)).toBe(false);
  });

  it('is independent per axis', () => {
    const TALL = {x: 3200, y: 0, width: 1024, height: 1280};
    expect(originWithin({x: 3300, y: 2000, width: 200, height: 100}, TALL)).toBe(false);
    expect(originWithin({x: 3300, y: 200, width: 200, height: 100}, TALL)).toBe(true);
  });
});
