import {describe, expect, it} from 'vitest';
import {classifyWindow, excludedFromTree, isResizable, type SizeLimits} from '../../../src/runtime/classify';
import type {WindowFacts, WindowInfo} from '../../../src/runtime/model';

const normal: WindowFacts = {
  type: 'normal',
  transient: false,
  attached: false,
  resizable: true,
};

describe('classifyWindow', () => {
  it('classifies an ordinary normal window as tiled', () => {
    expect(classifyWindow(normal)).toBe('tiled');
  });

  it.each([
    ['dialog', {type: 'dialog'}],
    ['modal dialog', {type: 'modal-dialog'}],
    ['utility', {type: 'utility'}],
    ['transient normal', {transient: true}],
    ['attached normal', {attached: true}],
    ['fixed-size normal', {resizable: false}],
  ] satisfies Array<[string, Partial<WindowFacts>]>)('classifies %s as floating', (_name, change) => {
    expect(classifyWindow({...normal, ...change})).toBe('floating');
  });

  // One case, not one row per native type: classifyWindow only ever sees the
  // normalised 'ignored' label, so extra rows would pass identical input and
  // imply coverage of the enum mapping that lives in src/shell/windows.ts.
  it('ignores a normalised ignored type even when it is transient', () => {
    expect(classifyWindow({...normal, type: 'ignored', transient: true})).toBeNull();
  });
});

describe('classifyWindow after the fact move', () => {
  // `sticky` used to map to null here, which made the tracker dispose the
  // watch and drop the window forever; it is not a classification input any
  // more, so this is the only reason left. The actual "does a sticky window
  // now stay tracked" story can no longer be told at this signature -- the
  // field it would vary left WindowFacts -- and lives instead in the
  // tracker's narrowed-contract test, in Task 3's engine tests (WindowInfo
  // keeps `sticky`), and in Task 5's native scenario.
  it('returns null only for a window type that is not ours', () => {
    expect(classifyWindow({...normal, type: 'ignored'})).toBeNull();
    expect(classifyWindow({...normal, type: 'dialog'})).toBe('floating');
    expect(classifyWindow({...normal, type: 'utility'})).toBe('floating');
  });
});

describe('excludedFromTree', () => {
  const info = (patch: Partial<WindowInfo>): WindowInfo => ({
    id: 1, kind: 'tiled', workspace: 0, monitor: 1,
    rect: {x: 0, y: 0, width: 10, height: 10}, title: 'w', wmClass: null,
    minimized: false, fullscreen: false, maximizedH: false, maximizedV: false,
    sticky: false, skipTaskbar: false, ...patch,
  });

  it('keeps an ordinary window in the tree', () => {
    expect(excludedFromTree(info({}))).toBe(false);
  });

  it('excludes a minimized, a sticky and a skip-taskbar window', () => {
    expect(excludedFromTree(info({minimized: true}))).toBe(true);
    expect(excludedFromTree(info({sticky: true}))).toBe(true);
    expect(excludedFromTree(info({skipTaskbar: true}))).toBe(true);
  });

  it('stays excluded while any one reason remains', () => {
    // Review Focus: a window both minimized and sticky rejoins only when BOTH
    // clear. Task 3 pins the engine half; this pins the predicate.
    expect(excludedFromTree(info({minimized: true, sticky: true}))).toBe(true);
    expect(excludedFromTree(info({minimized: false, sticky: true}))).toBe(true);
    expect(excludedFromTree(info({minimized: true, sticky: false}))).toBe(true);
  });

  it('ignores skip-taskbar on a window that already floats, but excludes it on a tiled one', () => {
    // Review Focus: pre-3B, classifyWindow() reached `skipTaskbar` only after
    // ruling out every reason a window floats (type, transient, attached,
    // fixed-size) -- a floating window never consulted it. §3.3 moved the
    // fact flatly and broke that: Mutter reports is_skip_taskbar() true for a
    // modal dialog (scenario A13), which used to float untouched and is now
    // dropped from the tree *and* the floating list. `kind` restores the
    // original narrowness.
    expect(excludedFromTree(info({kind: 'floating', skipTaskbar: true}))).toBe(false);
    expect(excludedFromTree(info({kind: 'tiled', skipTaskbar: true}))).toBe(true);
  });
});

// The readings below are what Mutter reports through the `resizeable` property
// and get_min_size()/get_max_size(); none of them mentions maximization,
// fullscreen or tiling, which is exactly the point. allows_resize() folds those
// transient states in, so it cannot be the fixed-size test.
const noHints: SizeLimits = {
  resizeable: true,
  fullscreen: false,
  minKnown: false, minWidth: 0, minHeight: 0,
  maxKnown: false, maxWidth: 0, maxHeight: 0,
};
// A terminal that opens maximized: Mutter keeps has_resize_func true, and the
// client set no program size hints, so both getters report "unknown" and 0.
const maximizedTerminal: SizeLimits = noHints;
// GTK's `resizable: false`: min and max are set to the same size, which also
// clears has_resize_func.
const fixedSize: SizeLimits = {
  resizeable: false,
  fullscreen: false,
  minKnown: true, minWidth: 360, minHeight: 240,
  maxKnown: true, maxWidth: 360, maxHeight: 240,
};
// has_resize_func absent for a reason of Mutter's own.
const noResizeFunction: SizeLimits = {...noHints, resizeable: false};
// A video player that opens fullscreen. recalc_features() clears has_resize_func
// while a window is fullscreen, so `resizeable` is false here for a reason that
// is not intrinsic either, and only the hints can answer.
const fullscreenAtMap: SizeLimits = {...noHints, resizeable: false, fullscreen: true};

describe('isResizable', () => {
  it('accepts a window whose client set no size hints', () => {
    // Regression: an unknown bound is an absent bound. Mutter reports an unset
    // hint as 0 with a false flag while defaulting internally to min 0 /
    // max G_MAXINT, so reading the 0s as real limits would make every hintless
    // window "fixed-size" - the same total failure, with the opposite cause.
    expect(isResizable(noHints)).toBe(true);
  });

  it('rejects a window with no resize function', () => {
    expect(isResizable(noResizeFunction)).toBe(false);
  });

  it('rejects a window whose minimum size equals its maximum size', () => {
    expect(isResizable(fixedSize)).toBe(false);
  });

  it('accepts a fullscreen window whose resize function Mutter cleared', () => {
    // meta_window_recalc_features(): "if (meta_window_is_fullscreen (window))
    // { ... window->has_resize_func = FALSE; ... }". For a normal window
    // has_resize_func is exactly !(min == max) && !fullscreen, so while the
    // window is fullscreen the property says nothing intrinsic and the hints
    // are the whole answer.
    expect(isResizable(fullscreenAtMap)).toBe(true);
  });

  it('still rejects a fixed-size window while it is fullscreen', () => {
    expect(isResizable({...fixedSize, fullscreen: true})).toBe(false);
  });

  it('applies the hint test on its own, without the resize function', () => {
    expect(isResizable({...fixedSize, resizeable: true})).toBe(false);
  });

  it.each([
    ['only a minimum', {minKnown: true, minWidth: 400, minHeight: 300}],
    ['only a maximum', {maxKnown: true, maxWidth: 400, maxHeight: 300}],
    ['a range in both dimensions', {
      minKnown: true, minWidth: 100, minHeight: 80,
      maxKnown: true, maxWidth: 400, maxHeight: 300,
    }],
    ['a fixed width but a free height', {
      minKnown: true, minWidth: 400, minHeight: 80,
      maxKnown: true, maxWidth: 400, maxHeight: 300,
    }],
    ['a fixed height but a free width', {
      minKnown: true, minWidth: 100, minHeight: 300,
      maxKnown: true, maxWidth: 400, maxHeight: 300,
    }],
  ] satisfies Array<[string, Partial<SizeLimits>]>)('accepts a window with %s', (_name, change) => {
    expect(isResizable({...noHints, ...change})).toBe(true);
  });
});

describe('classifyWindow over native size limits', () => {
  const classify = (limits: SizeLimits): ReturnType<typeof classifyWindow> =>
    classifyWindow({...normal, resizable: isResizable(limits)});

  it('tiles a normal window that is maximized when first seen', () => {
    // The live defect: GetWindows reported maximizedH/V true for two fresh
    // terminals and classified both floating, so nothing ever entered the tree.
    expect(classify(maximizedTerminal)).toBe('tiled');
  });

  it('floats a genuinely fixed-size normal window', () => {
    expect(classify(fixedSize)).toBe('floating');
  });

  it('floats a normal window whose resize function is absent', () => {
    expect(classify(noResizeFunction)).toBe('floating');
  });

  it('tiles a normal window that is fullscreen when first seen', () => {
    // The twin of the case above it: spec 19 keeps a fullscreen window's tree
    // slot, so a window that *opens* fullscreen must be adopted tiled.
    expect(classify(fullscreenAtMap)).toBe('tiled');
  });
});
