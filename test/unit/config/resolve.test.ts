import {describe, it, expect} from 'vitest';
import {loadConfigText} from '../../../src/config';
import {FALLBACK_CONFIG} from '../../../src/config/defaultConfig';

describe('resolve', () => {
  it('builds modes, bindings and workspace info', () => {
    const r = loadConfigText([
      'set $mod Mod4',
      'set $ws3 "3:III"',
      'bindsym $mod+3 workspace number $ws3',
      'bindsym $mod+Shift+3 move container to workspace number $ws3',
      'bindsym $mod+r mode "resize"',
      'mode "resize" {',
      ' bindsym Escape mode "default"',
      '}',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    const c = r.config!;
    expect([...c.modes.keys()]).toEqual(['default', 'resize']);
    expect(c.modes.get('default')!.bindings).toEqual([
      {accel: '<Super>3', combo: 'Mod4+3', command: 'workspace number "3:III"', noRepeat: false, line: 3},
      {accel: '<Super><Shift>3', combo: 'Mod4+Shift+3', command: 'move container to workspace number "3:III"', noRepeat: false, line: 4},
      {accel: '<Super>r', combo: 'Mod4+r', command: 'mode "resize"', noRepeat: false, line: 5},
    ]);
    expect(c.modes.get('resize')!.bindings).toEqual([
      {accel: 'Escape', combo: 'Escape', command: 'mode "default"', noRepeat: false, line: 7},
    ]);
    expect(c.workspaceCount).toBe(3);
    expect(c.workspaceNames.get(3)).toBe('3:III');
  });

  it('applies defaults when nothing is set', () => {
    const c = loadConfigText('bindsym Mod4+q kill').config!;
    expect(c.workspaceCount).toBe(0);
    expect(c.floatingModifier).toBe('Mod4');
    expect(c.focusWrapping).toBe('yes');
    expect(c.workspaceAutoBackAndForth).toBe(false);
    expect(c.defaultBorder).toEqual({style: 'normal', width: 2});
    expect(c.colors.focused.border).toBe('#4c7899');
  });

  it('later duplicate bindings win, with a warning', () => {
    const r = loadConfigText('bindsym Mod4+q kill\nbindsym Mod4+q nop');
    expect(r.config!.modes.get('default')!.bindings.map(b => b.command)).toEqual(['nop']);
    expect(r.diagnostics).toEqual([
      {line: 2, severity: 'warning', message: 'duplicate binding Mod4+q in mode "default"; the later one wins'},
    ]);
  });

  it('warns on unsupported directives and unknown commands but keeps the config', () => {
    const r = loadConfigText('exec --no-startup-id nm-applet\nbindsym Mod4+z frobnicate');
    expect(r.config).not.toBeNull();
    expect(r.diagnostics.map(d => [d.severity, d.line])).toEqual([['warning', 1], ['warning', 2]]);
  });

  it('records which client.* keys the config actually set', () => {
    // The resolved Colors are always fully populated with i3's defaults, so
    // they cannot answer "did the user ask for this colour?". Chrome that
    // falls back to the desktop accent needs that question answered.
    const c = loadConfigText('client.urgent #EC69A0 #DB3279 #FFFFFF').config!;
    expect([...c.specifiedColors]).toEqual(['urgent']);
  });

  it('records no specified colours when the config sets none', () => {
    const c = loadConfigText('bindsym Mod4+q kill').config!;
    expect([...c.specifiedColors]).toEqual([]);
  });

  it('fills missing colour fields like i3 (indicator from default, child_border from background)', () => {
    const c = loadConfigText('client.urgent #EC69A0 #DB3279 #FFFFFF').config!;
    expect(c.colors.urgent).toEqual({border: '#EC69A0', background: '#DB3279', text: '#FFFFFF', indicator: '#900000', childBorder: '#DB3279'});
  });

  it('parses for_window criteria into regexes', () => {
    const c = loadConfigText('for_window [title="^Audio (output|input)$" class="^kitty$" floating] floating enable').config!;
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0].criteria.title!.source).toBe('^Audio (output|input)$');
    expect(c.rules[0].criteria.class!.source).toBe('^kitty$');
    expect(c.rules[0].criteria.floating).toBe(true);
    expect(c.rules[0].command).toBe('floating enable');
    expect(loadConfigText('for_window [title="("] kill').diagnostics[0].message).toBe("criteria title: invalid regex '('");
    expect(loadConfigText('for_window [colour="x"] kill').diagnostics[0].message).toBe("criteria: unknown key 'colour'");
  });

  it('returns config null when any error exists', () => {
    const r = loadConfigText('bindsym Mod4+q kill\nbogus 1');
    expect(r.config).toBeNull();
    expect(r.diagnostics).toEqual([{line: 2, severity: 'error', message: 'unknown directive bogus'}]);
    expect(loadConfigText('bindsym Mod9+q kill').config).toBeNull();
  });

  it('preserves the set line number in a missing-value diagnostic', () => {
    const r = loadConfigText('# heading\nset $mod   \nbindsym Mod4+q kill');
    expect(r.config).toBeNull();
    expect(r.diagnostics).toEqual([{line: 2, severity: 'error', message: 'set: missing value'}]);
  });

  it('the built-in fallback config is valid', () => {
    const r = loadConfigText(FALLBACK_CONFIG);
    expect(r.diagnostics).toEqual([]);
    expect(r.config!.workspaceCount).toBe(10);
    expect(r.config!.modes.get('default')!.bindings).toHaveLength(25);
  });
});

describe('strip_workspace_numbers', () => {
  const load = (lines: string[]) => loadConfigText(lines.join('\n'));

  it('defaults to off, as i3 does', () => {
    const r = load(['set $ws1 "1:I"', 'bindsym Mod4+1 workspace number $ws1']);
    expect(r.config?.stripWorkspaceNumbers).toBe(false);
  });

  it('is on when the bar block says yes', () => {
    const r = load([
      'set $ws1 "1:I"',
      'bindsym Mod4+1 workspace number $ws1',
      'bar {',
      '  strip_workspace_numbers yes',
      '}',
    ]);
    expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
    expect(r.config?.stripWorkspaceNumbers).toBe(true);
  });

  it('is off when the bar block says no', () => {
    const r = load(['bar {', '  strip_workspace_numbers no', '}']);
    expect(r.config?.stripWorkspaceNumbers).toBe(false);
  });

  it('leaves the stored workspace name intact, so bindings still resolve', () => {
    const r = load([
      'set $ws1 "1:I"',
      'bindsym Mod4+1 workspace number $ws1',
      'bar {',
      '  strip_workspace_numbers yes',
      '}',
    ]);
    expect(r.config?.workspaceNames.get(1)).toBe('1:I');
  });
});
