import {describe, expect, it, vi} from 'vitest';

class FakeColor {
  constructor(public red: number, public green: number, public blue: number, public alpha = 255) {}
}
let themeAccent: [FakeColor | null, FakeColor | null] = [null, null];
const settingsSignals: Array<{signal: string; callback: () => void}> = [];
let disconnected: number[] = [];

vi.mock('gi://St', () => ({
  default: {
    ThemeContext: {get_for_stage: () => ({get_accent_color: () => themeAccent})},
    Settings: {
      get: () => ({
        connect: (signal: string, callback: () => void) => {
          settingsSignals.push({signal, callback});
          return settingsSignals.length;
        },
        disconnect: (id: number) => { disconnected.push(id); },
      }),
    },
  },
}));

const {ShellAccent} = await vi.importActual<{
  ShellAccent: new () => {
    current(): {background: string; text: string} | null;
    subscribe(callback: () => void): void;
    destroy(): void;
  };
}>('../../../src/shell/accent');

describe('ShellAccent', () => {
  it('reports the accent as hex, reading Cogl components as 0-255 bytes', () => {
    // Verified against a live nested shell: get_accent_color() returned
    // 53,132,228,255 for GNOME's blue, i.e. #3584e4 -- bytes, not 0-1 floats.
    themeAccent = [new FakeColor(53, 132, 228), new FakeColor(255, 255, 255)];
    expect(new ShellAccent().current()).toEqual({background: '#3584e4', text: '#ffffff'});
  });

  it('pads single-digit components', () => {
    themeAccent = [new FakeColor(10, 5, 0), new FakeColor(0, 0, 0)];
    expect(new ShellAccent().current()!.background).toBe('#0a0500');
  });

  it('reports no accent when the theme context has none', () => {
    themeAccent = [null, null];
    expect(new ShellAccent().current()).toBeNull();
  });

  it('notifies a subscriber when the desktop accent changes', () => {
    themeAccent = [new FakeColor(111, 131, 150), new FakeColor(255, 255, 255)];
    settingsSignals.length = 0;
    const accent = new ShellAccent();
    let fired = 0;
    accent.subscribe(() => { fired++; });
    expect(settingsSignals[0].signal).toBe('notify::accent-color');
    settingsSignals[0].callback();
    expect(fired).toBe(1);
  });

  it('disconnects its settings handler on destroy', () => {
    settingsSignals.length = 0;
    disconnected = [];
    const accent = new ShellAccent();
    accent.subscribe(() => {});
    accent.destroy();
    expect(disconnected).toEqual([settingsSignals.length]);
  });
});
