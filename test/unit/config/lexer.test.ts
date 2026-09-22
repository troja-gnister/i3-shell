import {describe, it, expect} from 'vitest';
import {logicalLines} from '../../../src/config/lexer';
import {substituteVariables} from '../../../src/config/variables';

describe('logicalLines', () => {
  it('drops blank and comment lines and keeps # inside values', () => {
    const src = '# i3 config\n\nset $mod Mod4   \nclient.focused #13BEAA #13BEAA #FFFFFF\n  # indented comment\n';
    expect(logicalLines(src)).toEqual([
      {line: 3, text: 'set $mod Mod4'},
      {line: 4, text: 'client.focused #13BEAA #13BEAA #FFFFFF'},
    ]);
  });

  it('joins backslash continuations and numbers them by the first physical line', () => {
    const src = 'bindsym $mod+x exec \\\n  foo \\\n  bar\nkill';
    expect(logicalLines(src)).toEqual([
      {line: 1, text: 'bindsym $mod+x exec   foo   bar'},
      {line: 4, text: 'kill'},
    ]);
  });

  it('accepts CRLF line endings', () => {
    expect(logicalLines('a\r\nb\r\n')).toEqual([{line: 1, text: 'a'}, {line: 2, text: 'b'}]);
  });

  it('keeps an ordinary final line without a trailing newline', () => {
    expect(logicalLines('bindsym Mod4+x exec true')).toEqual([
      {line: 1, text: 'bindsym Mod4+x exec true'},
    ]);
  });

  it('keeps an unterminated continuation at end of file', () => {
    expect(logicalLines('bindsym Mod4+x exec true\\')).toEqual([
      {line: 1, text: 'bindsym Mod4+x exec true'},
    ]);
  });
});

describe('substituteVariables', () => {
  it('substitutes longest names first and removes set lines', () => {
    const lines = logicalLines([
      'bindsym $mod+1 workspace number $ws1',
      'bindsym $mod+0 workspace number $ws10',
      'set $mod Mod4',
      'set $ws1 "1:I"',
      'set $ws10 "10:X"',
    ].join('\n'));
    const r = substituteVariables(lines);
    expect(r.diagnostics).toEqual([]);
    expect(r.lines).toEqual([
      {line: 1, text: 'bindsym Mod4+1 workspace number "1:I"'},
      {line: 2, text: 'bindsym Mod4+0 workspace number "10:X"'},
    ]);
  });

  it('leaves unknown $names alone so shell variables in exec keep working', () => {
    const r = substituteVariables(logicalLines('bindsym Mod4+e exec echo $HOME'));
    expect(r.lines[0].text).toBe('bindsym Mod4+e exec echo $HOME');
    expect(r.diagnostics).toEqual([]);
  });

  it('rejects invalid variable names', () => {
    const r = substituteVariables(logicalLines('set $1bad x'));
    expect(r.diagnostics).toEqual([{line: 1, severity: 'error', message: 'invalid variable name $1bad'}]);
  });

  it('accepts hyphens and dots after the first variable-name character', () => {
    const r = substituteVariables(logicalLines([
      'set $ws-1 1:I',
      'set $my.var x',
      'bindsym Mod4+1 workspace $ws-1',
      'bindsym Mod4+x exec $my.var',
    ].join('\n')));
    expect(r.diagnostics).toEqual([]);
    expect(r.lines).toEqual([
      {line: 3, text: 'bindsym Mod4+1 workspace 1:I'},
      {line: 4, text: 'bindsym Mod4+x exec x'},
    ]);
  });

  it('reports a missing set value and removes the set line', () => {
    const r = substituteVariables(logicalLines('set $mod   '));
    expect(r.lines).toEqual([]);
    expect(r.diagnostics).toEqual([{line: 1, severity: 'error', message: 'set: missing value'}]);
  });
});
