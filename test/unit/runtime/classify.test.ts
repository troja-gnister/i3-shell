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

  it.each([
    ['desktop'], ['dock'], ['toolbar'], ['menu'], ['splashscreen'],
    ['dropdown menu'], ['popup menu'], ['tooltip'], ['notification'],
    ['combo'], ['drag-and-drop'], ['other override-redirect'],
  ])('ignores the native %s type even when it is transient', () => {
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
