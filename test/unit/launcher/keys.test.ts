import {describe, it, expect} from 'vitest';
import {KEY, MOD, keyToAction} from '../../../src/launcher/keys';

/** A key press with no modifiers, no repeat, and the character the key makes. */
const press = (symbol: number, unicode = '', modifiers = 0, repeated = false) =>
  keyToAction(symbol, modifiers, unicode, repeated);

const MOD_KEY = MOD.super;
const ALT = MOD.alt;
const CTRL = MOD.control;
const SHIFT = MOD.shift;

describe('keyToAction: the modifier test runs before the symbol switch', () => {
  // This block is the reason the function was lifted out of the adapter. If
  // the modifier test is moved back below the switch, `$mod+Return` is claimed
  // by the Return case and ACCEPTS -- which, for a user whose i3 config binds
  // `$mod+Return` to "open a terminal", silently launches whatever happened to
  // be selected. These tests fail if that ordering is ever undone.

  it('$mod+Return dismisses and does not accept', () => {
    expect(press(KEY.Return, '\r', MOD_KEY)).toEqual({kind: 'dismiss'});
  });

  it('$mod+Return dismisses with the virtual Super bit too', () => {
    expect(press(KEY.Return, '\r', MOD.superVirtual)).toEqual({kind: 'dismiss'});
  });

  it('Alt+Return dismisses and does not accept', () => {
    expect(press(KEY.Return, '\r', ALT)).toEqual({kind: 'dismiss'});
  });

  it('Alt+Tab dismisses and does not complete', () => {
    expect(press(KEY.Tab, '\t', ALT)).toEqual({kind: 'dismiss'});
  });

  it('$mod+Tab dismisses and does not complete', () => {
    expect(press(KEY.Tab, '\t', MOD_KEY)).toEqual({kind: 'dismiss'});
  });

  it('$mod+Up and $mod+Down dismiss and do not navigate', () => {
    expect(press(KEY.Up, '', MOD_KEY)).toEqual({kind: 'dismiss'});
    expect(press(KEY.Down, '', MOD_KEY)).toEqual({kind: 'dismiss'});
  });

  it('$mod+BackSpace dismisses and does not delete a character', () => {
    expect(press(KEY.BackSpace, '\b', MOD_KEY)).toEqual({kind: 'dismiss'});
  });

  it('$mod+d dismisses rather than typing a d: the binding closes the launcher', () => {
    // The launcher is grabbed in POPUP mode, so the second press of the
    // opening chord never reaches the engine -- it arrives here.
    expect(press(0x0064, 'd', MOD_KEY)).toEqual({kind: 'dismiss'});
  });

  it('$mod+1 dismisses rather than typing a 1', () => {
    // A workspace binding must neither switch workspace nor leave a digit in
    // the query. The digit is the failure that looks like success.
    expect(press(0x0031, '1', MOD_KEY)).toEqual({kind: 'dismiss'});
  });
});

describe('keyToAction: Shift is not a dismissing modifier', () => {
  it('Shift+Return accepts into a terminal', () => {
    expect(press(KEY.Return, '\r', SHIFT)).toEqual({kind: 'acceptInTerminal'});
  });

  it('Shift+KP_Enter accepts into a terminal', () => {
    expect(press(KEY.KP_Enter, '\r', SHIFT)).toEqual({kind: 'acceptInTerminal'});
  });

  it('Shift+letter types uppercase', () => {
    expect(press(0x0046, 'F', SHIFT)).toEqual({kind: 'type', char: 'F'});
  });

  it('Shift+$mod+Return still dismisses: $mod wins', () => {
    expect(press(KEY.Return, '\r', SHIFT | MOD_KEY)).toEqual({kind: 'dismiss'});
  });
});

describe('keyToAction: Control navigates before it dismisses', () => {
  it('Ctrl+n moves down', () => {
    expect(press(KEY.n, 'n', CTRL)).toEqual({kind: 'down'});
  });

  it('Ctrl+p moves up', () => {
    expect(press(KEY.p, 'p', CTRL)).toEqual({kind: 'up'});
  });

  it('any other Control chord dismisses', () => {
    expect(press(0x0061, 'a', CTRL)).toEqual({kind: 'dismiss'});
    expect(press(0x0077, 'w', CTRL)).toEqual({kind: 'dismiss'});
  });

  it('Ctrl+Return still accepts: the switch claims it before the Control test', () => {
    expect(press(KEY.Return, '\r', CTRL)).toEqual({kind: 'accept'});
  });
});

describe('keyToAction: the plain keys', () => {
  const cases: Array<[string, number, string, unknown]> = [
    ['Escape dismisses', KEY.Escape, '\u001b', {kind: 'dismiss'}],
    ['Up moves up', KEY.Up, '', {kind: 'up'}],
    ['Down moves down', KEY.Down, '', {kind: 'down'}],
    ['Tab completes', KEY.Tab, '\t', {kind: 'complete'}],
    ['BackSpace deletes', KEY.BackSpace, '\b', {kind: 'backspace'}],
    ['Return accepts', KEY.Return, '\r', {kind: 'accept'}],
    ['KP_Enter accepts', KEY.KP_Enter, '\r', {kind: 'accept'}],
  ];
  for (const [label, symbol, unicode, expected] of cases)
    it(label, () => { expect(press(symbol, unicode)).toEqual(expected); });

  it('a plain letter types', () => {
    expect(press(0x0066, 'f')).toEqual({kind: 'type', char: 'f'});
  });

  it('space types', () => {
    expect(press(0x0020, ' ')).toEqual({kind: 'type', char: ' '});
  });

  it('an accented letter types', () => {
    expect(press(0x00e9, 'é')).toEqual({kind: 'type', char: 'é'});
  });

  it('a modifier key pressed on its own is ignored', () => {
    // Super_L: no unicode, no symbol case, and the state carries the
    // modifiers as they were BEFORE the press, so nothing is set yet.
    expect(press(0xffeb, '')).toBe(null);
  });
});

describe('keyToAction: Delete is not typable', () => {
  it('Delete produces no action at all', () => {
    // Clutter.KEY_Delete is 0xffff and maps to U+007F, the one control
    // character above space. A bare `>= " "` guard lets it through, it draws
    // as nothing, and the query it poisons matches nothing -- at which point
    // session.ts takes dmenu's fallthrough and the launcher SPAWNS
    // "fire\u007f" as a shell command.
    expect(press(KEY.Delete, '\u007f')).toBe(null);
  });

  it('every C0 control below space is ignored too', () => {
    for (const [symbol, unicode] of [[0xff08, '\b'], [0xff09, '\t'], [0xff0d, '\r'], [0xff1b, '\u001b']] as const) {
      // These four have symbol cases of their own; what is asserted here is
      // that nothing reaches the typing branch with a control character.
      const action = press(symbol, unicode);
      expect(action).not.toEqual({kind: 'type', char: unicode});
    }
    // One with no case of its own: Ctrl-less Linefeed.
    expect(press(0xff0a, '\n')).toBe(null);
  });

  it('a key that produces no character at all is ignored', () => {
    expect(press(0xffc0, '')).toBe(null);
  });

  it('types nothing for a key that produced no character at all', () => {
    // isTypable() has no `unicode !== ''` clause: the empty string sorts
    // before every non-empty one, so `'' >= ' '` is already false. This pins
    // the behaviour the deleted clause used to state twice.
    expect(press(0x0000, '')).toBe(null);
    expect(press(KEY.n, '')).toBe(null);
  });
});

describe('keyToAction: auto-repeat never dismisses', () => {
  it('a repeated $mod chord is ignored rather than dismissing', () => {
    // Holding the opening chord past the repeat delay would otherwise close
    // the launcher the instant it appeared, which looks exactly like "the
    // binding is broken".
    expect(press(0x0064, 'd', MOD_KEY, true)).toBe(null);
  });

  it('a repeated Control chord is ignored rather than dismissing', () => {
    expect(press(0x0061, 'a', CTRL, true)).toBe(null);
  });

  it('a repeated Down still navigates: holding it must scroll the list', () => {
    expect(press(KEY.Down, '', 0, true)).toEqual({kind: 'down'});
  });

  it('a repeated Ctrl+n still navigates', () => {
    expect(press(KEY.n, 'n', CTRL, true)).toEqual({kind: 'down'});
  });

  it('a repeated letter still types: holding BackSpace or a key must work', () => {
    expect(press(0x0066, 'f', 0, true)).toEqual({kind: 'type', char: 'f'});
    expect(press(KEY.BackSpace, '\b', 0, true)).toEqual({kind: 'backspace'});
  });

  it('a repeated Escape still dismisses: it is claimed by the switch', () => {
    expect(press(KEY.Escape, '\u001b', 0, true)).toEqual({kind: 'dismiss'});
  });
});
