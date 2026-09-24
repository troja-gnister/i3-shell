import {splitHead, tokenize, unquote} from '../util/text';
import type {LogicalLine} from './lexer';
import type {BorderStyle, Diagnostic} from './model';

export type ClientColorKey = 'focused' | 'focused_inactive' | 'unfocused' | 'urgent';

export type Directive =
  | {kind: 'bindsym'; line: number; mode: string; combo: string; command: string; noRepeat: boolean}
  | {kind: 'mode'; line: number; name: string}
  | {kind: 'for_window'; line: number; criteria: string; command: string}
  | {kind: 'default_border' | 'default_floating_border'; line: number; style: BorderStyle['style']; width: number}
  | {kind: 'floating_modifier'; line: number; value: string}
  | {kind: 'focus_wrapping'; line: number; value: string}
  | {kind: 'workspace_auto_back_and_forth'; line: number; value: string}
  | {kind: 'strip_workspace_numbers'; line: number; value: string}
  | {kind: 'client'; line: number; which: ClientColorKey; colors: string[]}
  | {kind: 'ignored'; line: number; name: string}
  | {kind: 'unsupported'; line: number; name: string};

export interface ParseResult {
  directives: Directive[];
  diagnostics: Diagnostic[];
}

/** Tier 3 (§6.3): valid i3, accepted with no effect, no warning. */
const IGNORED = new Set(['font', 'client.background', 'client.placeholder']);

/** Tier 2 (§6.3): valid i3, not implemented — warning, line skipped. */
const UNSUPPORTED = new Set([
  'bindcode', 'assign', 'workspace_layout', 'focus_follows_mouse', 'exec', 'exec_always',
  'gaps', 'hide_edge_borders', 'title_format', 'floating_minimum_size', 'floating_maximum_size',
  'force_focus_wrapping', 'popup_during_fullscreen', 'mouse_warping', 'focus_on_window_activation',
  'show_marks', 'smart_borders', 'smart_gaps', 'workspace', 'no_focus', 'ipc_socket',
  'restart_state', 'tiling_drag', 'title_align', 'include', 'set_from_resource',
]);

const COLOR_RE = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;

export function parse(lines: LogicalLine[]): ParseResult {
  const directives: Directive[] = [];
  const diagnostics: Diagnostic[] = [];
  let mode = 'default';
  let barDepth = 0;

  for (const l of lines) {
    const text = l.text;
    const err = (message: string): void => {
      diagnostics.push({line: l.line, severity: 'error', message});
    };

    if (barDepth > 0) {
      if (text.endsWith('{')) {
        barDepth++;
        continue;
      }
      if (text === '}') {
        barDepth--;
        continue;
      }
      // The bar is i3-shell's own panel, so the block stays ignored (§6.3) with
      // one exception: strip_workspace_numbers says how to render the pills.
      // Only at depth 1 — inside `colors { }` the word is not a bar option.
      if (barDepth === 1) {
        const [barHead, barRest] = splitHead(text);
        if (barHead === 'strip_workspace_numbers') {
          if (barRest !== 'yes' && barRest !== 'no') {
            err('strip_workspace_numbers: expected yes|no');
            continue;
          }
          directives.push({kind: 'strip_workspace_numbers', line: l.line, value: barRest});
        }
      }
      continue;
    }
    if (text === '}') {
      if (mode !== 'default')
        mode = 'default';
      else
        err('unexpected }');
      continue;
    }

    const [head, rest] = splitHead(text);

    if (head === 'bar' && rest.startsWith('{')) {
      barDepth = 1;
      directives.push({kind: 'ignored', line: l.line, name: 'bar'});
      continue;
    }

    if (head === 'mode') {
      const m = /^("[^"]*"|\S+)\s*\{$/.exec(rest);
      if (!m) {
        err('mode: expected mode "name" {');
        continue;
      }
      if (mode !== 'default') {
        err('mode: nested modes are not allowed');
        continue;
      }
      mode = unquote(m[1]);
      directives.push({kind: 'mode', line: l.line, name: mode});
      continue;
    }

    if (head === 'bindsym') {
      let remaining = rest;
      let noRepeat = false;
      let skip = false;
      while (remaining.startsWith('--')) {
        const [flag, after] = splitHead(remaining);
        remaining = after;
        if (flag === '--no-repeat') {
          noRepeat = true;
        } else if (flag === '--release') {
          directives.push({kind: 'unsupported', line: l.line, name: 'bindsym --release'});
          skip = true;
          break;
        } else {
          err(`bindsym: unknown flag ${flag}`);
          skip = true;
          break;
        }
      }
      if (skip)
        continue;
      const [combo, command] = splitHead(remaining);
      if (!combo) {
        err('bindsym: missing key combination');
        continue;
      }
      if (!command) {
        err('bindsym: missing command');
        continue;
      }
      directives.push({kind: 'bindsym', line: l.line, mode, combo, command, noRepeat});
      continue;
    }

    if (head === 'for_window') {
      const m = /^(\[[^\]]*\])\s*([\s\S]+)$/.exec(rest);
      if (!m) {
        err('for_window: expected [criteria] command');
        continue;
      }
      directives.push({kind: 'for_window', line: l.line, criteria: m[1], command: m[2].trim()});
      continue;
    }

    if (head === 'default_border' || head === 'default_floating_border' || head === 'new_window' || head === 'new_float') {
      const kind = head === 'new_window' ? 'default_border' : head === 'new_float' ? 'default_floating_border' : head;
      const t = tokenize(rest);
      const style = t[0];
      if (style === 'none') {
        directives.push({kind, line: l.line, style: 'none', width: 0});
      } else if (style === 'pixel' || style === 'normal') {
        const width = t[1] === undefined ? (style === 'pixel' ? 1 : 2) : Number(t[1]);
        if (!Number.isFinite(width)) {
          err(`${head}: bad width`);
          continue;
        }
        directives.push({kind, line: l.line, style, width});
      } else {
        err(`${head}: expected pixel|normal|none`);
      }
      continue;
    }

    if (head === 'floating_modifier') {
      if (rest !== 'Mod4' && rest !== 'Mod1' && rest !== 'none') {
        err('floating_modifier: expected Mod4|Mod1|none');
        continue;
      }
      directives.push({kind: 'floating_modifier', line: l.line, value: rest});
      continue;
    }

    if (head === 'focus_wrapping') {
      if (!['yes', 'no', 'force', 'workspace'].includes(rest)) {
        err('focus_wrapping: expected yes|no|force|workspace');
        continue;
      }
      directives.push({kind: 'focus_wrapping', line: l.line, value: rest});
      continue;
    }

    if (head === 'workspace_auto_back_and_forth') {
      if (rest !== 'yes' && rest !== 'no') {
        err('workspace_auto_back_and_forth: expected yes|no');
        continue;
      }
      directives.push({kind: 'workspace_auto_back_and_forth', line: l.line, value: rest});
      continue;
    }

    if (head.startsWith('client.')) {
      if (IGNORED.has(head)) {
        directives.push({kind: 'ignored', line: l.line, name: head});
        continue;
      }
      const which = head.slice('client.'.length);
      if (which === 'focused' || which === 'focused_inactive' || which === 'unfocused' || which === 'urgent') {
        const colors = tokenize(rest);
        if (colors.length < 3 || colors.length > 5 || !colors.every(c => COLOR_RE.test(c))) {
          err(`${head}: expected 3 to 5 #RRGGBB colours`);
          continue;
        }
        directives.push({kind: 'client', line: l.line, which, colors});
        continue;
      }
      err(`unknown directive ${head}`);
      continue;
    }

    if (IGNORED.has(head)) {
      directives.push({kind: 'ignored', line: l.line, name: head});
      continue;
    }
    if (UNSUPPORTED.has(head)) {
      directives.push({kind: 'unsupported', line: l.line, name: head});
      continue;
    }
    err(`unknown directive ${head}`);
  }

  const lastLine = lines.length > 0 ? lines[lines.length - 1].line : 0;
  if (mode !== 'default')
    diagnostics.push({line: lastLine, severity: 'error', message: `mode "${mode}": missing closing }`});
  if (barDepth > 0)
    diagnostics.push({line: lastLine, severity: 'error', message: 'bar: missing closing }'});
  return {directives, diagnostics};
}
