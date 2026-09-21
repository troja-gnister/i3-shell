import {logicalLines} from './lexer';
import {parse} from './parser';
import {resolve} from './resolve';
import type {ResolveResult} from './resolve';
import {substituteVariables} from './variables';

export type {BorderStyle, Binding, ColorSet, Colors, Config, Criteria, Diagnostic, Mode, Rule} from './model';
export {DEFAULT_COLORS} from './model';

/** Full pipeline for one config text. `config` is null iff at least one error was found. */
export function loadConfigText(text: string): ResolveResult {
  const substituted = substituteVariables(logicalLines(text));
  const resolved = resolve(parse(substituted.lines));
  const diagnostics = [...substituted.diagnostics, ...resolved.diagnostics].sort((a, b) => a.line - b.line);
  const rejected = diagnostics.some(d => d.severity === 'error');
  return {config: rejected ? null : resolved.config, diagnostics};
}
