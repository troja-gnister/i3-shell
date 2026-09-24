import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {loadConfigText} from '../../../src/config';

// examples/i3-shell.config is what a new user copies. A broken example is a
// broken first impression, so it is parsed here rather than trusted.
const text = readFileSync(new URL('../../../examples/i3-shell.config', import.meta.url), 'utf8');

describe('examples/i3-shell.config', () => {
  const result = loadConfigText(text);

  it('parses with no errors', () => {
    expect(result.diagnostics.filter(d => d.severity === 'error')).toEqual([]);
  });

  it('parses with no warnings, so every line it shows is a line i3-shell supports', () => {
    expect(result.diagnostics).toEqual([]);
  });

  it('leaves client.focused unset so the example demonstrates the accent fallback', () => {
    expect(result.config!.specifiedColors.has('focused')).toBe(false);
  });

  it('defines the workspaces its bindings reference', () => {
    expect(result.config!.workspaceCount).toBe(4);
    expect(result.config!.workspaceNames.get(1)).toBe('1:I');
  });

  it('demonstrates strip_workspace_numbers without changing the stored name', () => {
    expect(result.config!.stripWorkspaceNumbers).toBe(true);
    expect(result.config!.workspaceNames.get(1)).toBe('1:I');
  });
});
