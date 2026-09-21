import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {loadConfigText} from '../../../src/config';

const text = readFileSync(new URL('../fixtures/reference.i3config', import.meta.url), 'utf8');

describe("reference config (the user's real ~/.config/i3/config)", () => {
  const r = loadConfigText(text);
  const c = r.config!;
  const find = (mode: string, accel: string): string | undefined =>
    c.modes.get(mode)!.bindings.find(b => b.accel === accel)?.command;

  it('loads with no errors and no warnings', () => {
    expect(r.diagnostics).toEqual([]);
    expect(r.config).not.toBeNull();
  });

  it('has 65 default-mode and 11 resize-mode bindings', () => {
    expect([...c.modes.keys()]).toEqual(['default', 'resize']);
    expect(c.modes.get('default')!.bindings).toHaveLength(65);
    expect(c.modes.get('resize')!.bindings).toHaveLength(11);
  });

  it('maps the bindings that define the i3 feel', () => {
    expect(find('default', '<Super>Return')).toBe('exec --no-startup-id kitty');
    expect(find('default', '<Super><Shift>q')).toBe('kill');
    expect(find('default', '<Super>semicolon')).toBe('focus right');
    expect(find('default', '<Super><Shift>semicolon')).toBe('move right');
    expect(find('default', '<Super>1')).toBe('workspace number "1:I"');
    expect(find('default', '<Super><Shift>0')).toBe('move container to workspace number "10:X"');
    expect(find('default', '<Alt><Shift>4')).toBe('exec --no-startup-id ~/.local/bin/i3-screenshot-region');
    expect(find('default', 'XF86MonBrightnessUp')).toBe('exec --no-startup-id ~/.local/bin/i3-brightness display up');
    expect(find('default', '<Super>r')).toBe('mode "resize"');
    expect(find('resize', 'j')).toBe('resize shrink width 10 px or 10 ppt');
    expect(find('resize', 'Escape')).toBe('mode "default"');
    expect(find('resize', '<Super>r')).toBe('mode "default"');
  });

  it('resolves workspaces, colours, borders and the floating modifier', () => {
    expect(c.workspaceCount).toBe(10);
    expect(c.workspaceNames.get(1)).toBe('1:I');
    expect(c.workspaceNames.get(10)).toBe('10:X');
    expect(c.colors.focused).toEqual({border: '#13BEAA', background: '#13BEAA', text: '#FFFFFF', indicator: '#13BEAA', childBorder: '#13BEAA'});
    expect(c.colors.urgent.background).toBe('#DB3279');
    expect(c.defaultBorder).toEqual({style: 'pixel', width: 2});
    expect(c.defaultFloatingBorder).toEqual({style: 'pixel', width: 2});
    expect(c.floatingModifier).toBe('Mod4');
  });

  it('parses the for_window rule', () => {
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0].criteria.title!.source).toBe('^Audio (output|input)$');
    expect(c.rules[0].command).toBe('floating enable, border pixel 2, resize set 720 420, move position center');
  });
});
