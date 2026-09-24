import {describe, it, expect} from 'vitest';
import {execToCommand, launchFailure, launchPlan, terminalExec} from '../../../src/launcher/launch';
import type {LauncherItem} from '../../../src/launcher/model';

const app = (id = 'firefox.desktop', name = 'Firefox'): LauncherItem => ({
  source: 'app', id, name, genericName: 'Web Browser', keywords: [], icon: 'firefox', command: id,
});

const binary = (path = '/usr/bin/htop', name = 'htop'): LauncherItem => ({
  source: 'binary', id: path, name, genericName: null, keywords: [], icon: null, command: path,
});

describe('launchPlan', () => {
  describe('an application', () => {
    it('is handed to Gio by its .desktop id on a plain accept', () => {
      expect(launchPlan({kind: 'launch', item: app(), inTerminal: false}, 'kitty'))
        .toEqual({kind: 'app', id: 'firefox.desktop'});
    });

    it('never becomes a shell command on a plain accept, whatever the term is', () => {
      // The regression this whole module exists for: `item.command` for an
      // application is its .desktop id, not a command line.
      const plan = launchPlan({kind: 'launch', item: app(), inTerminal: false}, null);
      expect(plan.kind).toBe('app');
    });

    it('asks for its own command line to be resolved when Shift+Enter names a terminal', () => {
      // NOT {kind:'shell', command:'kitty -e firefox.desktop'} -- kitty would
      // open and die on "command not found", and before this the item had
      // already been promoted in the recency list as though it had launched.
      expect(launchPlan({kind: 'launch', item: app(), inTerminal: true}, 'kitty'))
        .toEqual({kind: 'appInTerminal', id: 'firefox.desktop', term: 'kitty'});
    });

    it('refuses Shift+Enter when the binding named no terminal', () => {
      expect(launchPlan({kind: 'launch', item: app(), inTerminal: true}, null))
        .toEqual({kind: 'noTerm'});
    });

    it('refuses Shift+Enter for an all-whitespace terminal, and does not pass it on', () => {
      expect(launchPlan({kind: 'launch', item: app(), inTerminal: true}, '   '))
        .toEqual({kind: 'noTerm'});
    });

    it('trims the terminal it passes on', () => {
      expect(launchPlan({kind: 'launch', item: app(), inTerminal: true}, '  kitty '))
        .toEqual({kind: 'appInTerminal', id: 'firefox.desktop', term: 'kitty'});
    });
  });

  describe('a $PATH binary', () => {
    it('runs its absolute path through the shell, quoted', () => {
      expect(launchPlan({kind: 'launch', item: binary(), inTerminal: false}, null))
        .toEqual({kind: 'shell', command: "'/usr/bin/htop'"});
    });

    it('survives a space in the path', () => {
      // `/home/u/my bin/tool` reached /bin/sh -c as two words and failed with
      // "not found".
      expect(launchPlan({kind: 'launch', item: binary('/home/u/my bin/tool', 'tool'), inTerminal: false}, null))
        .toEqual({kind: 'shell', command: "'/home/u/my bin/tool'"});
    });

    it('is quoted inside the terminal wrapper too', () => {
      expect(launchPlan({kind: 'launch', item: binary('/home/u/my bin/tool', 'tool'), inTerminal: true}, 'kitty'))
        .toEqual({kind: 'shell', command: "kitty -e '/home/u/my bin/tool'"});
    });

    it('refuses Shift+Enter with no terminal rather than running it bare', () => {
      expect(launchPlan({kind: 'launch', item: binary(), inTerminal: true}, null))
        .toEqual({kind: 'noTerm'});
    });
  });

  describe("dmenu's fallthrough", () => {
    it('runs the typed text verbatim, unquoted', () => {
      // This text IS shell, deliberately: quoting it would turn `ls | wc -l`
      // into an attempt to run a program of that name.
      expect(launchPlan({kind: 'exec', command: 'ls | wc -l', inTerminal: false}, 'kitty'))
        .toEqual({kind: 'shell', command: 'ls | wc -l'});
    });

    it('wraps it in the terminal on Shift+Enter, still unquoted', () => {
      expect(launchPlan({kind: 'exec', command: 'htop -d 5', inTerminal: true}, 'kitty'))
        .toEqual({kind: 'shell', command: 'kitty -e htop -d 5'});
    });

    it('refuses when no terminal was named', () => {
      expect(launchPlan({kind: 'exec', command: 'htop', inTerminal: true}, null))
        .toEqual({kind: 'noTerm'});
    });
  });
});

describe('execToCommand', () => {
  it('keeps a plain Exec line as it is', () => {
    expect(execToCommand('/usr/lib/firefox/firefox')).toBe('/usr/lib/firefox/firefox');
  });

  it('drops every file and URL field code', () => {
    expect(execToCommand('gedit %F')).toBe('gedit');
    expect(execToCommand('gedit %f')).toBe('gedit');
    expect(execToCommand('browser %u')).toBe('browser');
    expect(execToCommand('browser %U')).toBe('browser');
  });

  it('drops the deprecated and metadata field codes too', () => {
    // %i expands to `--icon <name>`, %c to the translated name, %k to the
    // entry's own path. None of them means anything for a bare launch, and a
    // literal `%i` on the command line is not a file the program can open.
    expect(execToCommand('app %d %D %n %N %i %c %k %v %m')).toBe('app');
  });

  it('keeps a literal percent', () => {
    expect(execToCommand('printf 100%% ')).toBe('printf 100%');
  });

  it('leaves an unknown percent escape alone rather than guessing', () => {
    expect(execToCommand('app %z arg')).toBe('app %z arg');
  });

  it("drops Flatpak's file-forwarding markers once their field code is gone", () => {
    // `flatpak run ... @@u %U @@` -- with %U stripped the markers bracket
    // nothing, and `flatpak run` would be handed `@@u` and `@@` as arguments.
    expect(execToCommand('/usr/bin/flatpak run --branch=stable com.valvesoftware.Steam @@u %U @@'))
      .toBe('/usr/bin/flatpak run --branch=stable com.valvesoftware.Steam');
  });

  it('collapses the whitespace a stripped code leaves behind', () => {
    expect(execToCommand('app   %F   --flag')).toBe('app --flag');
  });

  it('returns null for nothing to run', () => {
    expect(execToCommand(null)).toBe(null);
    expect(execToCommand('')).toBe(null);
    expect(execToCommand('   ')).toBe(null);
    // An Exec line of nothing but field codes: the caller must not spawn an
    // empty command, and `<term> -e ` with nothing after it is worse.
    expect(execToCommand('%F %U')).toBe(null);
  });
});

describe('terminalExec', () => {
  it('wraps the resolved command line', () => {
    expect(terminalExec('kitty', '/usr/lib/firefox/firefox %u')).toBe('kitty -e /usr/lib/firefox/firefox');
  });

  it('is null when the entry has no usable command line', () => {
    expect(terminalExec('kitty', null)).toBe(null);
    expect(terminalExec('kitty', '%F')).toBe(null);
  });
});

describe('launchFailure', () => {
  it('says nothing about a clean exit', () => {
    expect(launchFailure('htop', {exited: true, status: 0, signal: 0})).toBe(null);
  });

  it('names a command that was not found', () => {
    // /bin/sh's own code, and the one the A34 dmenu fallthrough produces for a
    // typo -- the case that was completely silent before.
    expect(launchFailure('frefox', {exited: true, status: 127, signal: 0}))
      .toBe('frefox: command not found');
  });

  it('names a command that is not executable', () => {
    expect(launchFailure('/etc/passwd', {exited: true, status: 126, signal: 0}))
      .toBe('/etc/passwd: not executable');
  });

  it('reports any other non-zero status with its number', () => {
    // A terminal that does not take `-e` picks its own status; spec 4.3
    // promises a notification here and cannot promise which number.
    expect(launchFailure('someterm -e htop', {exited: true, status: 1, signal: 0}))
      .toBe('someterm -e htop exited 1');
  });

  it('reports a signal death', () => {
    expect(launchFailure('hang', {exited: false, status: 0, signal: 9}))
      .toBe('hang was killed by signal 9');
  });
});
