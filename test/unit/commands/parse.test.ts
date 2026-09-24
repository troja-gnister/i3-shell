import {describe, it, expect} from 'vitest';
import {parseCommands, splitChain} from '../../../src/commands/parse';

describe('splitChain', () => {
  it('splits on ; and , outside double quotes', () => {
    expect(splitChain('floating enable, border pixel 2; move position center'))
      .toEqual(['floating enable', 'border pixel 2', 'move position center']);
    expect(splitChain('exec notify-send "a, b; c"')).toEqual(['exec notify-send "a, b; c"']);
  });
});

describe('parseCommands', () => {
  const one = (text: string) => {
    const r = parseCommands(text);
    expect(r.diagnostics).toEqual([]);
    expect(r.commands).toHaveLength(1);
    return r.commands[0];
  };

  it('exec keeps the raw command and strips --no-startup-id', () => {
    expect(one('exec --no-startup-id ~/.local/bin/i3-brightness display up'))
      .toEqual({type: 'exec', command: '~/.local/bin/i3-brightness display up', noStartupId: true});
    expect(one('exec kitty')).toEqual({type: 'exec', command: 'kitty', noStartupId: false});
    expect(one('exec "i3-nagbar -t warning -m \'Exit i3?\'"'))
      .toEqual({type: 'exec', command: "i3-nagbar -t warning -m 'Exit i3?'", noStartupId: false});
  });

  it('parses workspace targets', () => {
    expect(one('workspace number "1:I"')).toEqual({type: 'workspace', target: {kind: 'number', number: 1, name: '1:I'}});
    expect(one('workspace number 10')).toEqual({type: 'workspace', target: {kind: 'number', number: 10, name: '10'}});
    expect(one('workspace next')).toEqual({type: 'workspace', target: {kind: 'next'}});
    expect(one('workspace back_and_forth')).toEqual({type: 'workspace', target: {kind: 'back_and_forth'}});
    expect(one('workspace "mail"')).toEqual({type: 'workspace', target: {kind: 'name', name: 'mail'}});
    expect(one('move container to workspace number "10:X"'))
      .toEqual({type: 'move_to_workspace', target: {kind: 'number', number: 10, name: '10:X'}});
  });

  it('parses focus, move, split, layout', () => {
    expect(one('focus left')).toEqual({type: 'focus', target: 'left'});
    expect(one('focus parent')).toEqual({type: 'focus', target: 'parent'});
    expect(one('focus mode_toggle')).toEqual({type: 'focus', target: 'mode_toggle'});
    expect(one('move right')).toEqual({type: 'move', direction: 'right'});
    expect(one('move position center')).toEqual({type: 'move_position', position: 'center'});
    expect(one('split h')).toEqual({type: 'split', orientation: 'h'});
    expect(one('split vertical')).toEqual({type: 'split', orientation: 'v'});
    expect(one('layout stacking')).toEqual({type: 'layout', layout: 'stacked'});
    expect(one('layout tabbed')).toEqual({type: 'layout', layout: 'tabbed'});
    expect(one('layout toggle split')).toEqual({type: 'layout_toggle', cycle: 'split'});
    expect(one('layout toggle all')).toEqual({type: 'layout_toggle', cycle: 'all'});
    expect(one('layout toggle tabbed splitv')).toEqual({type: 'layout_toggle', cycle: ['tabbed', 'splitv']});
  });

  it('parses fullscreen, floating, kill, mode, reload, restart, nop', () => {
    expect(one('fullscreen toggle')).toEqual({type: 'fullscreen', action: 'toggle'});
    expect(one('fullscreen')).toEqual({type: 'fullscreen', action: 'toggle'});
    expect(one('floating toggle')).toEqual({type: 'floating', action: 'toggle'});
    expect(one('kill')).toEqual({type: 'kill'});
    expect(one('mode "resize"')).toEqual({type: 'mode', name: 'resize'});
    expect(one('mode default')).toEqual({type: 'mode', name: 'default'});
    expect(one('reload')).toEqual({type: 'reload'});
    expect(one('restart')).toEqual({type: 'restart'});
    expect(one('nop')).toEqual({type: 'nop', text: ''});
  });

  it('parses resize forms', () => {
    expect(one('resize shrink width 10 px or 10 ppt'))
      .toEqual({type: 'resize', action: 'shrink', dimension: 'width', px: 10, ppt: 10});
    expect(one('resize grow height 5 ppt'))
      .toEqual({type: 'resize', action: 'grow', dimension: 'height', px: 10, ppt: 5});
    expect(one('resize grow width'))
      .toEqual({type: 'resize', action: 'grow', dimension: 'width', px: 10, ppt: 10});
    expect(one('resize set 720 420')).toEqual({type: 'resize_set', width: 720, height: 420});
  });

  it('parses border', () => {
    expect(one('border pixel 2')).toEqual({type: 'border', style: 'pixel', width: 2});
    expect(one('border none')).toEqual({type: 'border', style: 'none', width: 0});
    expect(one('border toggle')).toEqual({type: 'border', style: 'toggle', width: 0});
  });

  it('chains and reports unknown commands without dropping them', () => {
    const r = parseCommands('floating enable, border pixel 2, resize set 720 420, move position center');
    expect(r.commands.map(c => c.type)).toEqual(['floating', 'border', 'resize_set', 'move_position']);
    const bad = parseCommands('frobnicate now; kill');
    expect(bad.commands).toEqual([{type: 'unknown', text: 'frobnicate now'}, {type: 'kill'}]);
    expect(bad.diagnostics).toEqual(["unknown command 'frobnicate'"]);
  });
});

describe('launcher', () => {
  it('parses with no terminal', () => {
    expect(parseCommands('launcher').commands).toEqual([{type: 'launcher', term: null}]);
  });

  it('parses --term with its command', () => {
    expect(parseCommands('launcher --term kitty').commands).toEqual([{type: 'launcher', term: 'kitty'}]);
  });

  it('keeps a quoted multi-word terminal whole', () => {
    expect(parseCommands('launcher --term "flatpak run org.wezfurlong.wezterm"').commands)
      .toEqual([{type: 'launcher', term: 'flatpak run org.wezfurlong.wezterm'}]);
  });

  it('rejects --term with no value', () => {
    const r = parseCommands('launcher --term');
    expect(r.diagnostics).toEqual(['launcher: --term needs a command']);
    expect(r.commands).toEqual([{type: 'unknown', text: 'launcher --term'}]);
  });

  it('rejects an unknown flag rather than treating it as a terminal', () => {
    const r = parseCommands('launcher --bogus');
    expect(r.diagnostics).toEqual(["launcher: unknown option '--bogus'"]);
  });
});
