import {describe, it, expect} from 'vitest';
import {comboToAccel, canonicalAccel} from '../../../src/config/accel';

describe('comboToAccel', () => {
  it('maps i3 modifiers to Mutter accelerator syntax', () => {
    expect(comboToAccel('Mod4+semicolon')).toEqual({accel: '<Super>semicolon'});
    expect(comboToAccel('Mod4+Shift+4')).toEqual({accel: '<Super><Shift>4'});
    expect(comboToAccel('Mod1+Shift+4')).toEqual({accel: '<Alt><Shift>4'});
    expect(comboToAccel('Control+Mod4+space')).toEqual({accel: '<Control><Super>space'});
    expect(comboToAccel('Mod2+Mod4+a')).toEqual({accel: '<Super>a'});
    expect(comboToAccel('XF86MonBrightnessUp')).toEqual({accel: 'XF86MonBrightnessUp'});
    expect(comboToAccel('Escape')).toEqual({accel: 'Escape'});
  });

  it('rejects malformed combos', () => {
    expect(comboToAccel('Mod9+x')).toEqual({error: "unknown modifier 'Mod9' in 'Mod9+x'"});
    expect(comboToAccel('Mod4+')).toEqual({error: "malformed key combination 'Mod4+'"});
    expect(comboToAccel('Mod4+é')).toEqual({error: "unsupported key name 'é' in 'Mod4+é'"});
  });
});

describe('canonicalAccel', () => {
  it('equates GNOME and i3-shell spellings of the same accelerator', () => {
    expect(canonicalAccel('<Shift><Super>space')).toBe(canonicalAccel('<Super><Shift>space'));
    expect(canonicalAccel('<Primary><Alt>t')).toBe(canonicalAccel('<Control><Alt>T'));
    expect(canonicalAccel('<Super>1')).toBe('<super>1');
    expect(canonicalAccel('XF86AudioRaiseVolume')).toBe('xf86audioraisevolume');
  });
});
