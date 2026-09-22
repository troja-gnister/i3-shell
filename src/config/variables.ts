import type {LogicalLine} from './lexer';
import type {Diagnostic} from './model';

export interface SubstituteResult {
  lines: LogicalLine[];
  diagnostics: Diagnostic[];
}

const SET_RE = /^set\s+(\S+)(?:\s+([\s\S]*))?$/;
const NAME_RE = /^\$[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Collects `set $name value` lines and substitutes the names textually in every other
 * line, longest name first (so $ws10 is not clobbered by $ws1) — i3 semantics.
 * Unknown `$names` are left untouched: they may be shell variables inside `exec`.
 */
export function substituteVariables(lines: LogicalLine[]): SubstituteResult {
  const variables = new Map<string, string>();
  const rest: LogicalLine[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const l of lines) {
    if (!/^set(?:\s|$)/.test(l.text)) {
      rest.push(l);
      continue;
    }
    const m = SET_RE.exec(l.text);
    if (!m) {
      diagnostics.push({line: l.line, severity: 'error', message: 'set: missing value'});
      continue;
    }
    if (!NAME_RE.test(m[1])) {
      diagnostics.push({line: l.line, severity: 'error', message: `invalid variable name ${m[1]}`});
      continue;
    }
    if (m[2] === undefined || m[2].trim() === '') {
      diagnostics.push({line: l.line, severity: 'error', message: 'set: missing value'});
      continue;
    }
    variables.set(m[1], m[2].trim());
  }

  const names = [...variables.keys()].sort((a, b) => b.length - a.length);
  const substituted = rest.map(l => {
    let text = l.text;
    for (const name of names)
      text = text.split(name).join(variables.get(name) as string);
    return {line: l.line, text};
  });
  return {lines: substituted, diagnostics};
}
