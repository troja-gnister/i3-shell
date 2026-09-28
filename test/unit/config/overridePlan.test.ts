import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {loadConfigText} from '../../../src/config';
import {planOverrides} from '../../../src/config/overridePlan';

describe('planOverrides', () => {
  it('derives accelerators, workspace names and the mouse modifier from the reference config', () => {
    const text = readFileSync(new URL('../fixtures/reference.i3config', import.meta.url), 'utf8');
    const plan = planOverrides(loadConfigText(text).config!);
    expect(plan.accels).toHaveLength(65);
    expect(plan.accels).toContain('<Super>1');
    expect(plan.accels).not.toContain('j');                     // resize-mode bindings are transient grabs
    expect(plan.workspaceCount).toBe(10);
    expect(plan.mouseButtonModifier).toBe('<Super>');
  });

  it('fills gaps in workspace numbering with plain numbers and maps other modifiers', () => {
    const plan = planOverrides(loadConfigText('floating_modifier Mod1\nbindsym Mod4+3 workspace number "3:web"').config!);
    expect(plan.workspaceCount).toBe(3);
    expect(plan.mouseButtonModifier).toBe('<Alt>');
    expect(planOverrides(loadConfigText('floating_modifier none').config!).mouseButtonModifier).toBe('');
  });

  it('maps focus_follows_mouse to a GNOME focus mode', () => {
    expect(planOverrides(loadConfigText('').config!).focusMode).toBe('sloppy');
    expect(planOverrides(loadConfigText('focus_follows_mouse no').config!).focusMode).toBe('click');
    expect(planOverrides(loadConfigText('focus_follows_mouse yes').config!).focusMode).toBe('sloppy');
  });
});
