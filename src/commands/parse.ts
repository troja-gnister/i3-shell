import {tokenize, unquote} from '../util/text';
import type {Command, CommandParseResult, Direction, Layout, WorkspaceTarget} from './model';

/** Splits a command chain on ';' and ',' that are outside double quotes (i3 semantics). */
export function splitChain(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && (ch === ';' || ch === ',')) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

const DIRECTIONS: readonly string[] = ['left', 'right', 'up', 'down'];
const isDirection = (s: string | undefined): s is Direction => s !== undefined && DIRECTIONS.includes(s);

function normalizeLayout(s: string): Layout | null {
  if (s === 'splith' || s === 'splitv' || s === 'tabbed')
    return s;
  if (s === 'stacking' || s === 'stacked')
    return 'stacked';
  return null;
}

function workspaceTarget(args: string[]): WorkspaceTarget | null {
  if (args.length === 0)
    return null;
  if (args[0] === 'next')
    return {kind: 'next'};
  if (args[0] === 'prev')
    return {kind: 'prev'};
  if (args[0] === 'back_and_forth')
    return {kind: 'back_and_forth'};
  if (args[0] === 'number') {
    const name = unquote(args.slice(1).join(' '));
    const m = /^(\d+)/.exec(name);
    if (!m)
      return null;
    return {kind: 'number', number: parseInt(m[1], 10), name};
  }
  return {kind: 'name', name: unquote(args.join(' '))};
}

/** Parses one command (no chaining). Returns a Command, or an error message. */
function parseOne(segment: string): Command | string {
  const t = tokenize(segment);
  const head = t[0];
  const args = t.slice(1);
  switch (head) {
    case 'exec': {
      let rest = segment.slice('exec'.length).trim();
      let noStartupId = false;
      if (rest.startsWith('--no-startup-id')) {
        noStartupId = true;
        rest = rest.slice('--no-startup-id'.length).trim();
      }
      if (!rest)
        return 'exec: missing command';
      return {type: 'exec', command: unquote(rest), noStartupId};
    }
    case 'kill':
      return {type: 'kill'};
    case 'focus': {
      const a = args[0];
      if (isDirection(a) || a === 'parent' || a === 'child' || a === 'mode_toggle')
        return {type: 'focus', target: a};
      return `focus: unknown target '${a ?? ''}'`;
    }
    case 'move': {
      if (isDirection(args[0]))
        return {type: 'move', direction: args[0]};
      if (args[0] === 'container' && args[1] === 'to' && args[2] === 'workspace') {
        const target = workspaceTarget(args.slice(3));
        return target ? {type: 'move_to_workspace', target} : 'move container to workspace: missing target';
      }
      if (args[0] === 'position') {
        if (args[1] === 'center')
          return {type: 'move_position', position: 'center'};
        const x = Number(args[1]);
        const y = Number(args[2]);
        if (Number.isFinite(x) && Number.isFinite(y))
          return {type: 'move_position', position: {x, y}};
        return 'move position: expected center or X Y';
      }
      return `move: unsupported form '${args.join(' ')}'`;
    }
    case 'split': {
      const a = args[0];
      if (a === 'h' || a === 'horizontal')
        return {type: 'split', orientation: 'h'};
      if (a === 'v' || a === 'vertical')
        return {type: 'split', orientation: 'v'};
      if (a === 'toggle')
        return {type: 'split', orientation: 'toggle'};
      return `split: unknown orientation '${a ?? ''}'`;
    }
    case 'layout': {
      const a = args[0];
      if (a === 'toggle') {
        const rest = args.slice(1);
        // bare `layout toggle` is treated like `layout toggle all`
        if (rest.length === 0 || (rest.length === 1 && rest[0] === 'all'))
          return {type: 'layout_toggle', cycle: 'all'};
        if (rest.length === 1 && rest[0] === 'split')
          return {type: 'layout_toggle', cycle: 'split'};
        const list = rest.map(normalizeLayout);
        if (list.every(l => l !== null))
          return {type: 'layout_toggle', cycle: list as Layout[]};
        return `layout toggle: unknown layout in '${rest.join(' ')}'`;
      }
      const layout = a === undefined ? null : normalizeLayout(a);
      return layout ? {type: 'layout', layout} : `layout: unknown layout '${a ?? ''}'`;
    }
    case 'fullscreen': {
      const a = args[0] ?? 'toggle';
      if (a === 'toggle' || a === 'enable' || a === 'disable')
        return {type: 'fullscreen', action: a};
      return `fullscreen: unknown argument '${a}'`;
    }
    case 'floating': {
      const a = args[0];
      if (a === 'toggle' || a === 'enable' || a === 'disable')
        return {type: 'floating', action: a};
      return 'floating: expected toggle|enable|disable';
    }
    case 'workspace': {
      const target = workspaceTarget(args);
      return target ? {type: 'workspace', target} : 'workspace: missing target';
    }
    case 'resize': {
      if (args[0] === 'set') {
        const width = Number(args[1]);
        const height = Number(args[2]);
        if (Number.isFinite(width) && Number.isFinite(height))
          return {type: 'resize_set', width, height};
        return 'resize set: expected W H';
      }
      const action = args[0];
      const dimension = args[1];
      if ((action !== 'grow' && action !== 'shrink') || (dimension !== 'width' && dimension !== 'height'))
        return 'resize: expected grow|shrink width|height';
      const rest = args.slice(2);
      let px = 10;
      let ppt: number | null = rest.length === 0 ? 10 : null;   // i3 default: 10 px or 10 ppt
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === 'or')
          continue;
        const n = Number(rest[i]);
        const unit = rest[i + 1];
        if (Number.isFinite(n) && unit === 'px') {
          px = n;
          i++;
        } else if (Number.isFinite(n) && unit === 'ppt') {
          ppt = n;
          i++;
        } else {
          return `resize: cannot parse '${rest.join(' ')}'`;
        }
      }
      return {type: 'resize', action, dimension, px, ppt};
    }
    case 'border': {
      const a = args[0];
      if (a === 'pixel' || a === 'normal') {
        const fallback = a === 'pixel' ? 1 : 2;
        const width = args[1] === undefined ? fallback : Number(args[1]);
        return {type: 'border', style: a, width: Number.isFinite(width) ? width : fallback};
      }
      if (a === 'none')
        return {type: 'border', style: 'none', width: 0};
      if (a === 'toggle')
        return {type: 'border', style: 'toggle', width: 0};
      return `border: unknown style '${a ?? ''}'`;
    }
    case 'mode': {
      const name = unquote(args.join(' '));
      return name ? {type: 'mode', name} : 'mode: missing name';
    }
    case 'reload':
      return {type: 'reload'};
    case 'restart':
      return {type: 'restart'};
    case 'nop':
      return {type: 'nop', text: args.join(' ')};
    default:
      return `unknown command '${head ?? ''}'`;
  }
}

export function parseCommands(text: string): CommandParseResult {
  const commands: Command[] = [];
  const diagnostics: string[] = [];
  for (const segment of splitChain(text)) {
    const result = parseOne(segment);
    if (typeof result === 'string') {
      diagnostics.push(result);
      commands.push({type: 'unknown', text: segment});
    } else {
      commands.push(result);
    }
  }
  return {commands, diagnostics};
}
