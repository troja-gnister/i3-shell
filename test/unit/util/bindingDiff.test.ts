import {describe, it, expect} from 'vitest';
import {diffBindings} from '../../../src/util/bindingDiff';
import type {Binding} from '../../../src/config/model';

const b = (accel: string, command: string, noRepeat = false): Binding => ({accel, combo: accel, command, noRepeat, line: 1});

describe('diffBindings', () => {
  it('grabs everything when nothing is grabbed', () => {
    const d = diffBindings(new Map(), [b('<Super>1', 'workspace number 1')]);
    expect(d).toEqual({ungrab: [], grab: [b('<Super>1', 'workspace number 1')]});
  });

  it('ungrabs bindings that disappeared and keeps unchanged ones', () => {
    const current = new Map([['<Super>1', b('<Super>1', 'workspace number 1')], ['<Super>2', b('<Super>2', 'workspace number 2')]]);
    const d = diffBindings(current, [b('<Super>1', 'workspace number 1')]);
    expect(d).toEqual({ungrab: ['<Super>2'], grab: []});
  });

  it('re-grabs a binding whose command or flag changed', () => {
    const current = new Map([['<Super>1', b('<Super>1', 'workspace number 1')], ['<Super>f', b('<Super>f', 'fullscreen toggle')]]);
    const wanted = [b('<Super>1', 'workspace number 1', true), b('<Super>f', 'fullscreen toggle')];
    const d = diffBindings(current, wanted);
    expect(d).toEqual({ungrab: ['<Super>1'], grab: [b('<Super>1', 'workspace number 1', true)]});
  });

  it('switching modes replaces the whole set', () => {
    const current = new Map([['<Super>r', b('<Super>r', 'mode "resize"')]]);
    const d = diffBindings(current, [b('j', 'resize shrink width 10 px or 10 ppt'), b('Escape', 'mode "default"')]);
    expect(d.ungrab).toEqual(['<Super>r']);
    expect(d.grab.map(x => x.accel)).toEqual(['j', 'Escape']);
  });
});
