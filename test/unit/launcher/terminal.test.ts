import {describe, it, expect} from 'vitest';
import {shellQuote, terminalCommand} from '../../../src/launcher/terminal';

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

describe('shellQuote', () => {
  it('quotes an ordinary path so /bin/sh sees one word', () => {
    expect(shellQuote('/usr/bin/htop')).toBe("'/usr/bin/htop'");
  });

  it('survives a space in the path', () => {
    // `/home/u/my bin/tool` reached /bin/sh -c as two words and failed with
    // "not found" -- a $PATH directory with a space in it is unusual, not
    // invalid.
    expect(shellQuote('/home/u/my bin/tool')).toBe("'/home/u/my bin/tool'");
  });

  it('neutralises every metacharacter that would otherwise be shell', () => {
    expect(shellQuote('/tmp/a$b;rm -rf ~')).toBe("'/tmp/a$b;rm -rf ~'");
    expect(shellQuote('/tmp/`whoami`')).toBe("'/tmp/`whoami`'");
    expect(shellQuote('/tmp/a|b')).toBe("'/tmp/a|b'");
    expect(shellQuote('/tmp/a&b')).toBe("'/tmp/a&b'");
    expect(shellQuote('/tmp/a"b')).toBe(`'/tmp/a"b'`);
  });

  it("closes, escapes and reopens around a single quote", () => {
    // The one character single quotes cannot contain. Anything else here --
    // a backslash before the quote, say -- leaves the rest of the command
    // line inside an unterminated quote.
    expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
  });

  it('quotes the empty string as an empty word rather than nothing', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('wraps cleanly inside a terminal command', () => {
    expect(terminalCommand('kitty', shellQuote('/home/u/my bin/tool')))
      .toBe("kitty -e '/home/u/my bin/tool'");
  });
});
