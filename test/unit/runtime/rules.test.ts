import {describe, it, expect} from 'vitest';
import {matchesCriteria} from '../../../src/runtime/rules';
import type {Criteria} from '../../../src/config/model';
import type {WindowInfo} from '../../../src/runtime/model';

const info = (patch: Partial<WindowInfo> = {}): WindowInfo => ({
  id: 1, kind: 'tiled', workspace: 0, monitor: 10,
  rect: {x: 0, y: 0, width: 100, height: 100},
  title: 'Audio output', wmClass: 'gnome-control-center',
  instance: 'gnome-control-center', appId: 'org.gnome.Settings', role: 'dialog',
  minimized: false, fullscreen: false, maximizedH: false, maximizedV: false,
  sticky: false, skipTaskbar: false, urgent: false, ...patch,
});
const c = (criteria: Criteria): Criteria => criteria;

describe('matchesCriteria', () => {
  it('matches a single title regex', () => {
    expect(matchesCriteria(c({title: /^Audio (output|input)$/}), info())).toBe(true);
    expect(matchesCriteria(c({title: /^Audio (output|input)$/}), info({title: 'Sound'}))).toBe(false);
  });

  it('matches each of the five regex criteria against its own fact', () => {
    // Each key gets a positive AND a negative case: a positive-only assertion
    // passes even if the check were deleted, since an unchecked criterion
    // returns true. The negative half is what makes the test's name honest.
    expect(matchesCriteria(c({class: /^gnome-control-center$/}), info())).toBe(true);
    expect(matchesCriteria(c({class: /^kitty$/}), info())).toBe(false);
    expect(matchesCriteria(c({instance: /control/}), info())).toBe(true);
    expect(matchesCriteria(c({instance: /^nope$/}), info())).toBe(false);
    expect(matchesCriteria(c({app_id: /^org\.gnome\.Settings$/}), info())).toBe(true);
    expect(matchesCriteria(c({app_id: /^org\.gnome\.Nope$/}), info())).toBe(false);
    expect(matchesCriteria(c({window_role: /^dialog$/}), info())).toBe(true);
    expect(matchesCriteria(c({window_role: /^toolbar$/}), info())).toBe(false);
  });

  it('requires EVERY present criterion to match, as i3 does', () => {
    const criteria = c({title: /^Audio output$/, class: /^gnome-control-center$/});
    expect(matchesCriteria(criteria, info())).toBe(true);
    expect(matchesCriteria(criteria, info({wmClass: 'kitty'}))).toBe(false);
  });

  it('never matches a regex against an absent fact, not even .*', () => {
    // Absence is not the empty string. A window with no role must not be
    // swept up by a rule that says "any role".
    expect(matchesCriteria(c({window_role: /.*/}), info({role: null}))).toBe(false);
    expect(matchesCriteria(c({app_id: /.*/}), info({appId: null}))).toBe(false);
    expect(matchesCriteria(c({class: /.*/}), info({wmClass: null}))).toBe(false);
    expect(matchesCriteria(c({instance: /.*/}), info({instance: null}))).toBe(false);
  });

  it('answers floating and tiling from kind', () => {
    expect(matchesCriteria(c({floating: true}), info({kind: 'floating'}))).toBe(true);
    expect(matchesCriteria(c({floating: true}), info({kind: 'tiled'}))).toBe(false);
    expect(matchesCriteria(c({tiling: true}), info({kind: 'tiled'}))).toBe(true);
    expect(matchesCriteria(c({tiling: true}), info({kind: 'floating'}))).toBe(false);
  });

  it('matches empty criteria against anything, since the parser rejects an empty [] itself', () => {
    expect(matchesCriteria(c({}), info())).toBe(true);
  });

  it('is not anchored implicitly -- the config author owns the anchors', () => {
    expect(matchesCriteria(c({title: /Audio/}), info())).toBe(true);
    expect(matchesCriteria(c({title: /^Audio$/}), info())).toBe(false);
  });

  it('does not mutate a regex lastIndex across calls', () => {
    // A /g regex would advance lastIndex and answer differently the second
    // time. The parser does not add flags, but the function must not care.
    const criteria = c({title: /Audio/g});
    expect(matchesCriteria(criteria, info())).toBe(true);
    expect(matchesCriteria(criteria, info())).toBe(true);
  });
});
