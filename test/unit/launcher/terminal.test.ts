import {describe, it, expect} from 'vitest';
import {terminalCommand} from '../../../src/launcher/terminal';

describe('terminalCommand', () => {
  it('wraps a command in the configured terminal', () => {
    expect(terminalCommand('kitty', 'htop')).toBe('kitty -e htop');
  });

  it('wraps a multi-word terminal command', () => {
    expect(terminalCommand('flatpak run org.wezfurlong.wezterm', 'htop'))
      .toBe('flatpak run org.wezfurlong.wezterm -e htop');
  });

  it('returns null when no terminal was configured', () => {
    // The caller warns and does nothing. It must never spawn `undefined -e htop`.
    expect(terminalCommand(null, 'htop')).toBe(null);
  });

  it('returns null for an all-whitespace terminal', () => {
    expect(terminalCommand('   ', 'htop')).toBe(null);
  });
});
