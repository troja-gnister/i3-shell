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
    expect(plan.workspaceNames).toEqual(['1:I', '2:II', '3:III', '4:IV', '5:V', '6:VI', '7:VII', '8:VIII', '9:IX', '10:X']);
    expect(plan.mouseButtonModifier).toBe('<Super>');
  });

  it('fills gaps in workspace numbering with plain numbers and maps other modifiers', () => {
    const plan = planOverrides(loadConfigText('floating_modifier Mod1\nbindsym Mod4+3 workspace number "3:web"').config!);
    expect(plan.workspaceCount).toBe(3);
    expect(plan.workspaceNames).toEqual(['1', '2', '3:web']);
    expect(plan.mouseButtonModifier).toBe('<Alt>');
    expect(planOverrides(loadConfigText('floating_modifier none').config!).mouseButtonModifier).toBe('');
  });
});

describe('planOverrides with strip_workspace_numbers', () => {
  const withStrip = (extra: string) => loadConfigText([
    'bindsym Mod4+1 workspace number "1:I"',
    'bindsym Mod4+2 workspace number "2:II"',
    extra,
  ].join('\n')).config!;

  it('gives GNOME the stripped names, so the overview matches the pills', () => {
    const plan = planOverrides(withStrip('bar {\n  strip_workspace_numbers yes\n}'));
    expect(plan.workspaceNames).toEqual(['I', 'II']);
  });

  it('gives GNOME the full names when stripping is off', () => {
    const plan = planOverrides(withStrip('# no bar block'));
    expect(plan.workspaceNames).toEqual(['1:I', '2:II']);
  });

  it('leaves a gap-filled plain number alone, since it has no prefix', () => {
    const plan = planOverrides(loadConfigText([
      'bindsym Mod4+3 workspace number "3:web"',
      'bar {',
      '  strip_workspace_numbers yes',
      '}',
    ].join('\n')).config!);
    expect(plan.workspaceNames).toEqual(['1', '2', 'web']);
  });
});
