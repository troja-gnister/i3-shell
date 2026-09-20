import {describe, it, expect} from 'vitest';
import {logicalLines} from '../../../src/config/lexer';
import {parse} from '../../../src/config/parser';

const P = (src: string) => parse(logicalLines(src));

describe('parse directives', () => {
  it('bindsym with flags, modes and raw commands', () => {
    const r = P([
      'bindsym Mod4+Return exec --no-startup-id kitty',
      'bindsym --no-repeat Mod4+f fullscreen toggle',
      'mode "resize" {',
      '  bindsym j resize shrink width 10 px or 10 ppt',
      '  bindsym Escape mode "default"',
      '}',
      'bindsym Mod4+r mode "resize"',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'bindsym', line: 1, mode: 'default', combo: 'Mod4+Return', command: 'exec --no-startup-id kitty', noRepeat: false},
      {kind: 'bindsym', line: 2, mode: 'default', combo: 'Mod4+f', command: 'fullscreen toggle', noRepeat: true},
      {kind: 'mode', line: 3, name: 'resize'},
      {kind: 'bindsym', line: 4, mode: 'resize', combo: 'j', command: 'resize shrink width 10 px or 10 ppt', noRepeat: false},
      {kind: 'bindsym', line: 5, mode: 'resize', combo: 'Escape', command: 'mode "default"', noRepeat: false},
      {kind: 'bindsym', line: 7, mode: 'default', combo: 'Mod4+r', command: 'mode "resize"', noRepeat: false},
    ]);
  });

  it('appearance and behaviour directives', () => {
    const r = P([
      'default_border pixel 2',
      'default_floating_border normal',
      'floating_modifier Mod4',
      'focus_wrapping force',
      'workspace_auto_back_and_forth yes',
      'client.focused #13BEAA #13BEAA #FFFFFF #13BEAA #13BEAA',
      'client.urgent #EC69A0 #DB3279 #FFFFFF',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'default_border', line: 1, style: 'pixel', width: 2},
      {kind: 'default_floating_border', line: 2, style: 'normal', width: 2},
      {kind: 'floating_modifier', line: 3, value: 'Mod4'},
      {kind: 'focus_wrapping', line: 4, value: 'force'},
      {kind: 'workspace_auto_back_and_forth', line: 5, value: 'yes'},
      {kind: 'client', line: 6, which: 'focused', colors: ['#13BEAA', '#13BEAA', '#FFFFFF', '#13BEAA', '#13BEAA']},
      {kind: 'client', line: 7, which: 'urgent', colors: ['#EC69A0', '#DB3279', '#FFFFFF']},
    ]);
  });

  it('for_window keeps the criteria text and the raw command', () => {
    const r = P('for_window [title="^Audio (output|input)$"] floating enable, border pixel 2');
    expect(r.directives).toEqual([
      {kind: 'for_window', line: 1, criteria: '[title="^Audio (output|input)$"]', command: 'floating enable, border pixel 2'},
    ]);
  });

  it('three tiers: silent, unsupported, error', () => {
    const r = P([
      'font pango:Poppins 12',
      'client.background #FFFFFF',
      'bar {',
      '  status_command i3status',
      '}',
      'exec --no-startup-id nm-applet',
      'bindsym --release Mod4+x kill',
      'frobnicate 1',
    ].join('\n'));
    expect(r.directives).toEqual([
      {kind: 'ignored', line: 1, name: 'font'},
      {kind: 'ignored', line: 2, name: 'client.background'},
      {kind: 'ignored', line: 3, name: 'bar'},
      {kind: 'unsupported', line: 6, name: 'exec'},
      {kind: 'unsupported', line: 7, name: 'bindsym --release'},
    ]);
    expect(r.diagnostics).toEqual([{line: 8, severity: 'error', message: 'unknown directive frobnicate'}]);
  });

  it('reports structural errors', () => {
    expect(P('mode "a" {\nmode "b" {\n}').diagnostics.map(d => d.message)).toEqual(['mode: nested modes are not allowed']);
    expect(P('mode "a" {\nbindsym x kill').diagnostics).toEqual([{line: 2, severity: 'error', message: 'mode "a": missing closing }'}]);
    expect(P('}').diagnostics).toEqual([{line: 1, severity: 'error', message: 'unexpected }'}]);
    expect(P('client.focused #123').diagnostics[0].message).toBe('client.focused: expected 3 to 5 #RRGGBB colours');
    expect(P('bindsym Mod4+x').diagnostics[0].message).toBe('bindsym: missing command');
    expect(P('floating_modifier Mod3').diagnostics[0].message).toBe('floating_modifier: expected Mod4|Mod1|none');
  });
});
