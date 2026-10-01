import {describe, expect, it} from 'vitest';
import {neighbourMonitor} from '../../../src/tree/monitors';
import type {MonitorId, Rect} from '../../../src/tree/node';

const rect = (x: number, y: number, width: number, height: number): Rect => ({x, y, width, height});

/** The reporter's real desk: a 3840-wide ultrawide at the origin, a 1920 television to its right. */
const desk = new Map<MonitorId, Rect>([
  [3, rect(0, 32, 3840, 1048)],
  [2, rect(3840, 28, 1920, 1052)],
]);

describe('neighbourMonitor', () => {
  it('finds the output beyond the edge on the direction axis', () => {
    expect(neighbourMonitor(desk, 3, 'right')).toBe(2);
    expect(neighbourMonitor(desk, 2, 'left')).toBe(3);
  });

  it('has no neighbour off the ends', () => {
    expect(neighbourMonitor(desk, 2, 'right')).toBeNull();
    expect(neighbourMonitor(desk, 3, 'left')).toBeNull();
  });

  it('has no vertical neighbour for side-by-side outputs', () => {
    expect(neighbourMonitor(desk, 3, 'down')).toBeNull();
    expect(neighbourMonitor(desk, 3, 'up')).toBeNull();
  });

  it('refuses a diagonal output: it is not to the right of anything', () => {
    const diagonal = new Map<MonitorId, Rect>([
      [0, rect(0, 0, 100, 100)],
      [1, rect(200, 200, 100, 100)],
    ]);
    expect(neighbourMonitor(diagonal, 0, 'right')).toBeNull();
    expect(neighbourMonitor(diagonal, 0, 'down')).toBeNull();
  });

  it('picks the nearest of two candidates beyond the edge', () => {
    const three = new Map<MonitorId, Rect>([
      [0, rect(0, 0, 100, 100)],
      [1, rect(100, 0, 100, 100)],
      [2, rect(200, 0, 100, 100)],
    ]);
    expect(neighbourMonitor(three, 0, 'right')).toBe(1);
    expect(neighbourMonitor(three, 2, 'left')).toBe(1);
  });

  it('treats a touching edge as beyond, and an overlap as not', () => {
    const touching = new Map<MonitorId, Rect>([[0, rect(0, 0, 100, 100)], [1, rect(100, 0, 100, 100)]]);
    expect(neighbourMonitor(touching, 0, 'right')).toBe(1);
    const overlapping = new Map<MonitorId, Rect>([[0, rect(0, 0, 100, 100)], [1, rect(50, 0, 100, 100)]]);
    expect(neighbourMonitor(overlapping, 0, 'right')).toBeNull();
  });

  it('stacked outputs are neighbours vertically, not horizontally', () => {
    const stacked = new Map<MonitorId, Rect>([[0, rect(0, 0, 100, 100)], [1, rect(0, 100, 100, 100)]]);
    expect(neighbourMonitor(stacked, 0, 'down')).toBe(1);
    expect(neighbourMonitor(stacked, 0, 'right')).toBeNull();
  });

  it('returns null for an output it does not know', () => {
    expect(neighbourMonitor(desk, 99, 'right')).toBeNull();
  });
});
