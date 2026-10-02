import {describe, it, expect} from 'vitest';
import {logicalLines} from '../../../src/config/lexer';
import {parse} from '../../../src/config/parser';
import {loadConfigText} from '../../../src/config';

const P = (src: string) => parse(logicalLines(src));
/** Full pipeline (parse + resolve): `workspace N output` lands in the resolved Config, not a Directive. */
const load = (src: string) => loadConfigText(src);

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

  it('skips bar blocks with nested sub-blocks and reports an unclosed one', () => {
    const r = P('bar {\n  status_command i3status\n  colors {\n    background #000000\n  }\n}\nbindsym Mod4+q kill');
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'ignored', line: 1, name: 'bar'},
      {kind: 'bindsym', line: 7, mode: 'default', combo: 'Mod4+q', command: 'kill', noRepeat: false},
    ]);
    expect(P('bar {\n  colors {\n  }').diagnostics).toEqual([{line: 3, severity: 'error', message: 'bar: missing closing }'}]);
  });
});

describe('bar block', () => {
  it('reads strip_workspace_numbers and still ignores the rest of the block', () => {
    const r = P([
      'bar {',
      '  status_command i3status',
      '  strip_workspace_numbers yes',
      '  colors {',
      '    background #000000',
      '  }',
      '}',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'ignored', line: 1, name: 'bar'},
      {kind: 'strip_workspace_numbers', line: 3, value: 'yes'},
    ]);
  });

  it('reads an explicit no', () => {
    const r = P(['bar {', '  strip_workspace_numbers no', '}'].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'ignored', line: 1, name: 'bar'},
      {kind: 'strip_workspace_numbers', line: 2, value: 'no'},
    ]);
  });

  it('emits no directive when the block does not mention it', () => {
    const r = P(['bar {', '  status_command i3status', '}'].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([{kind: 'ignored', line: 1, name: 'bar'}]);
  });

  it('rejects a value that is not yes or no', () => {
    const r = P(['bar {', '  strip_workspace_numbers maybe', '}'].join('\n'));
    expect(r.diagnostics).toEqual([
      {line: 2, severity: 'error', message: 'strip_workspace_numbers: expected yes|no'},
    ]);
  });

  it('ignores the key inside a nested block, where it is not a bar option', () => {
    const r = P([
      'bar {',
      '  colors {',
      '    strip_workspace_numbers yes',
      '  }',
      '}',
    ].join('\n'));
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([{kind: 'ignored', line: 1, name: 'bar'}]);
  });

  it('ignores the key outside a bar block, where i3 does not define it', () => {
    const r = P('strip_workspace_numbers yes');
    expect(r.directives).toEqual([]);
    expect(r.diagnostics).toEqual([
      {line: 1, severity: 'error', message: 'unknown directive strip_workspace_numbers'},
    ]);
  });
});

describe('workspace N output', () => {
  it('parses workspace N output', () => {
    const {config, diagnostics} = load('workspace 2 output DP-1\n');
    expect(diagnostics).toEqual([]);
    expect(config!.workspaceOutputs.get(1)).toEqual({names: ['DP-1'], line: 1});
  });

  it("takes the workspace number from a name's leading digits, as workspace number does", () => {
    const {config} = load('workspace "3:III" output HDMI-1\n');
    expect(config!.workspaceOutputs.get(2)).toEqual({names: ['HDMI-1'], line: 1});
  });

  it("accepts i3's list of outputs, first live one winning at resolution", () => {
    const {config} = load('workspace 1 output primary DP-1 HDMI-1\n');
    expect(config!.workspaceOutputs.get(0)!.names).toEqual(['primary', 'DP-1', 'HDMI-1']);
  });

  it('warns on a workspace directive with no output clause, rather than accepting it silently', () => {
    const {diagnostics} = load('workspace 1 gaps inner 5\n');
    expect(diagnostics.map(d => d.severity)).toEqual(['warning']);
    expect(diagnostics[0]!.message).toMatch(/workspace/);
  });

  it('rejects a workspace directive whose number is not a number', () => {
    const {diagnostics} = load('workspace bogus output DP-1\n');
    expect(diagnostics.map(d => d.severity)).toEqual(['warning']);
  });

  it('rejects workspace 0, rather than silently recording an unreachable zero-based index of -1', () => {
    // Fix round 1, F3: i3 workspace numbers are 1-based; workspaceNumber("0") legitimately returns 0
    // (it *is* a leading digit), so without this guard `index = number - 1` would store -1, a key no
    // real workspace index can ever match, and the pin would silently do nothing forever.
    const {config, diagnostics} = load('workspace 0 output DP-1\n');
    expect(diagnostics.map(d => d.severity)).toEqual(['warning']);
    expect(diagnostics[0]!.message).toMatch(/workspace/);
    expect(config!.workspaceOutputs.size).toBe(0);
  });
});

describe('focus_follows_mouse', () => {
  it('defaults to yes, as i3 does', () => {
    expect(load('').config!.focusFollowsMouse).toBe(true);
  });

  it('parses an explicit no', () => {
    const {config, diagnostics} = load('focus_follows_mouse no\n');
    expect(diagnostics).toEqual([]);
    expect(config!.focusFollowsMouse).toBe(false);
  });

  it('parses an explicit yes', () => {
    const {config, diagnostics} = load('focus_follows_mouse yes\n');
    expect(diagnostics).toEqual([]);
    expect(config!.focusFollowsMouse).toBe(true);
  });

  it('rejects a value that is not yes or no', () => {
    const r = P('focus_follows_mouse perhaps\n');
    expect(r.diagnostics).toEqual([
      {line: 1, severity: 'error', message: "focus_follows_mouse: expected yes or no, got 'perhaps'"},
    ]);
  });
});

describe('mouse_warping', () => {
  it('defaults to output, as i3 does', () => {
    expect(load('').config!.mouseWarping).toBe('output');
  });

  it('parses an explicit none', () => {
    const {config, diagnostics} = load('mouse_warping none\n');
    expect(diagnostics).toEqual([]);
    expect(config!.mouseWarping).toBe('none');
  });

  it('parses an explicit output', () => {
    const {config, diagnostics} = load('mouse_warping output\n');
    expect(diagnostics).toEqual([]);
    expect(config!.mouseWarping).toBe('output');
  });

  it('accepts container (i3 4.17), treats it as output, and warns once', () => {
    // Fix round 1, I3: a valid i3 value must never fail the load. `container` warps on any focus
    // change, which this design does not implement, so it folds into the closest approximation
    // (`output`) with a warning rather than being rejected as malformed.
    const {config, diagnostics} = load('mouse_warping container\n');
    expect(diagnostics).toEqual([
      {line: 1, severity: 'warning',
        message: 'mouse_warping container: warping on any focus change is not implemented; treating it as output'},
    ]);
    expect(config!.mouseWarping).toBe('output');
  });

  it('rejects a value that is not output, container or none', () => {
    // `err`, not `warn`: every implemented directive with an enumerated value rejects a malformed one
    // (Task 11 settled this identically for focus_follows_mouse), so one typo does not silently default.
    const r = P('mouse_warping perhaps\n');
    expect(r.diagnostics).toEqual([
      {line: 1, severity: 'error', message: "mouse_warping: expected output, container or none, got 'perhaps'"},
    ]);
  });
});

/**
 * `bindgesture` is not i3 syntax -- i3 has no gestures at all. It is borrowed from sway, which is where
 * a user who wants one will look first, and it joins `launcher` as a deliberate non-i3 directive.
 */
describe('bindgesture', () => {
  it('binds a command to each horizontal swipe', () => {
    const r = P('bindgesture swipe:left workspace next\nbindgesture swipe:right workspace prev\n');
    expect(r.diagnostics).toEqual([]);
    expect(r.directives).toEqual([
      {kind: 'bindgesture', line: 1, gesture: 'swipe:left', command: 'workspace next'},
      {kind: 'bindgesture', line: 2, gesture: 'swipe:right', command: 'workspace prev'},
    ]);
  });

  it('resolves into the config, keyed by gesture, with the line that bound it', () => {
    const {config, diagnostics} = load('bindgesture swipe:left workspace next\n');
    expect(diagnostics).toEqual([]);
    expect([...config!.gestures]).toEqual([
      ['swipe:left', {gesture: 'swipe:left', command: 'workspace next', line: 1}],
    ]);
  });

  it('binds nothing by default: an unbound gesture is the normal state', () => {
    expect(load('').config!.gestures.size).toBe(0);
  });

  it('rejects a gesture name it does not implement', () => {
    // Styled on `mouse_warping`'s error and erring for the same reason: an enumerated value that is not
    // in the enumeration is a typo, and a parser that silently ignored it would leave the user with a
    // gesture that does nothing and no way to find out why.
    const r = P('bindgesture swipe:up workspace next\n');
    expect(r.diagnostics).toEqual([
      {line: 1, severity: 'error', message: "bindgesture: expected swipe:left or swipe:right, got 'swipe:up'"},
    ]);
    expect(r.directives).toEqual([]);
  });

  it('rejects sway gesture kinds other than swipe', () => {
    const r = P('bindgesture pinch:inward workspace next\n');
    expect(r.diagnostics).toEqual([
      {line: 1, severity: 'error', message: "bindgesture: expected swipe:left or swipe:right, got 'pinch:inward'"},
    ]);
  });

  it('rejects a gesture with no command', () => {
    expect(P('bindgesture swipe:left\n').diagnostics).toEqual([
      {line: 1, severity: 'error', message: 'bindgesture: missing command'},
    ]);
  });

  it('warns and keeps the later binding when one gesture is bound twice', () => {
    // Matches `bindsym`'s own duplicate rule, which is i3's: the last line wins.
    const {config, diagnostics} = load('bindgesture swipe:left workspace next\nbindgesture swipe:left nop\n');
    expect(diagnostics).toEqual([
      {line: 2, severity: 'warning', message: 'duplicate bindgesture swipe:left; the later one wins'},
    ]);
    expect(config!.gestures.get('swipe:left')).toEqual({gesture: 'swipe:left', command: 'nop', line: 2});
  });

  it('validates the bound command at load time, as bindsym does', () => {
    const {diagnostics} = load('bindgesture swipe:left wobble\n');
    expect(diagnostics).toEqual([{line: 1, severity: 'warning', message: "unknown command 'wobble'"}]);
  });
});
