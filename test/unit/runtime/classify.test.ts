import {describe, expect, it} from 'vitest';
import {classifyWindow} from '../../../src/runtime/classify';
import type {WindowFacts} from '../../../src/runtime/model';

const normal: WindowFacts = {
  type: 'normal',
  skipTaskbar: false,
  transient: false,
  attached: false,
  sticky: false,
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
    ['hidden transient normal', {skipTaskbar: true, transient: true}],
  ] satisfies Array<[string, Partial<WindowFacts>]>)('classifies %s as floating', (_name, change) => {
    expect(classifyWindow({...normal, ...change})).toBe('floating');
  });

  // One case, not one row per native type: classifyWindow only ever sees the
  // normalised 'ignored' label, so extra rows would pass identical input and
  // imply coverage of the enum mapping that lives in src/shell/windows.ts.
  it('ignores a normalised ignored type even when it is transient', () => {
    expect(classifyWindow({...normal, type: 'ignored', transient: true})).toBeNull();
  });

  it.each([
    ['skip-taskbar', {skipTaskbar: true}],
    ['sticky', {sticky: true}],
    ['sticky and skip-taskbar', {sticky: true, skipTaskbar: true}],
  ] satisfies Array<[string, Partial<WindowFacts>]>)('ignores an otherwise ordinary %s window', (_name, change) => {
    expect(classifyWindow({...normal, ...change})).toBeNull();
  });
});
