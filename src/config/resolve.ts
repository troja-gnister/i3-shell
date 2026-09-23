import {parseCommands} from '../commands/parse';
import {comboToAccel} from './accel';
import {DEFAULT_COLORS} from './model';
import type {Binding, ColorSet, Colors, Config, Criteria, Diagnostic, Mode, Rule} from './model';
import type {ParseResult} from './parser';

export interface ResolveResult {
  config: Config | null;
  diagnostics: Diagnostic[];
}

const CRITERIA_REGEX_KEYS = ['class', 'instance', 'title', 'app_id', 'window_role'] as const;

/** `[title="^Audio$" class="kitty" floating]` → Criteria. Pushes an error and returns null on bad input. */
export function parseCriteria(text: string, line: number, diagnostics: Diagnostic[]): Criteria | null {
  const inner = text.slice(1, -1).trim();
  const criteria: Criteria = {};
  const re = /(\w+)(?:="([^"]*)"|=(\S+))?/g;
  let any = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    any = true;
    const key = m[1];
    const value = m[2] ?? m[3];
    if (key === 'floating' || key === 'tiling') {
      criteria[key] = true;
      continue;
    }
    if (!(CRITERIA_REGEX_KEYS as readonly string[]).includes(key)) {
      diagnostics.push({line, severity: 'error', message: `criteria: unknown key '${key}'`});
      return null;
    }
    if (value === undefined) {
      diagnostics.push({line, severity: 'error', message: `criteria ${key}: missing value`});
      return null;
    }
    try {
      criteria[key as typeof CRITERIA_REGEX_KEYS[number]] = new RegExp(value);
    } catch {
      diagnostics.push({line, severity: 'error', message: `criteria ${key}: invalid regex '${value}'`});
      return null;
    }
  }
  if (!any) {
    diagnostics.push({line, severity: 'error', message: 'criteria: empty'});
    return null;
  }
  return criteria;
}

function colorSet(colors: string[], base: ColorSet): ColorSet {
  return {
    border: colors[0],
    background: colors[1],
    text: colors[2],
    indicator: colors[3] ?? base.indicator,
    childBorder: colors[4] ?? colors[1],
  };
}

export function resolve(parsed: ParseResult): ResolveResult {
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  const modes = new Map<string, Mode>([['default', {name: 'default', bindings: []}]]);
  const rules: Rule[] = [];
  const colors: Colors = {...DEFAULT_COLORS};
  const specifiedColors = new Set<keyof Colors>();
  const workspaceNames = new Map<number, string>();
  const config: Config = {
    modes, rules, colors, specifiedColors, workspaceNames,
    defaultBorder: {style: 'normal', width: 2},
    defaultFloatingBorder: {style: 'normal', width: 2},
    floatingModifier: 'Mod4',
    focusWrapping: 'yes',
    workspaceAutoBackAndForth: false,
    workspaceCount: 0,
  };

  /** Validates a command string now (so typos surface at load) and records workspace numbers/names. */
  const inspectCommand = (commandText: string, line: number): void => {
    const {commands, diagnostics: problems} = parseCommands(commandText);
    for (const p of problems)
      diagnostics.push({line, severity: 'warning', message: p});
    for (const c of commands) {
      const target = c.type === 'workspace' || c.type === 'move_to_workspace' ? c.target : null;
      if (target && target.kind === 'number' && !workspaceNames.has(target.number))
        workspaceNames.set(target.number, target.name);
    }
  };

  for (const d of parsed.directives) {
    switch (d.kind) {
      case 'mode':
        if (!modes.has(d.name))
          modes.set(d.name, {name: d.name, bindings: []});
        break;
      case 'bindsym': {
        const r = comboToAccel(d.combo);
        if ('error' in r) {
          diagnostics.push({line: d.line, severity: 'error', message: r.error});
          break;
        }
        let mode = modes.get(d.mode);
        if (!mode) {
          mode = {name: d.mode, bindings: []};
          modes.set(d.mode, mode);
        }
        if (mode.bindings.some(b => b.accel === r.accel)) {
          diagnostics.push({line: d.line, severity: 'warning', message: `duplicate binding ${d.combo} in mode "${d.mode}"; the later one wins`});
          mode.bindings = mode.bindings.filter(b => b.accel !== r.accel);
        }
        const binding: Binding = {accel: r.accel, combo: d.combo, command: d.command, noRepeat: d.noRepeat, line: d.line};
        mode.bindings.push(binding);
        inspectCommand(d.command, d.line);
        break;
      }
      case 'for_window': {
        const criteria = parseCriteria(d.criteria, d.line, diagnostics);
        if (criteria) {
          rules.push({criteria, command: d.command, line: d.line});
          inspectCommand(d.command, d.line);
        }
        break;
      }
      case 'default_border':
        config.defaultBorder = {style: d.style, width: d.width};
        break;
      case 'default_floating_border':
        config.defaultFloatingBorder = {style: d.style, width: d.width};
        break;
      case 'floating_modifier':
        config.floatingModifier = d.value as Config['floatingModifier'];
        break;
      case 'focus_wrapping':
        config.focusWrapping = d.value as Config['focusWrapping'];
        break;
      case 'workspace_auto_back_and_forth':
        config.workspaceAutoBackAndForth = d.value === 'yes';
        break;
      case 'client': {
        const key = d.which === 'focused_inactive' ? 'focusedInactive' : d.which;
        colors[key] = colorSet(d.colors, DEFAULT_COLORS[key]);
        specifiedColors.add(key);
        break;
      }
      case 'unsupported':
        diagnostics.push({line: d.line, severity: 'warning', message: `${d.name} is not supported by i3-shell yet; line skipped`});
        break;
      case 'ignored':
        break;
      default: {
        const unexpected: never = d;
        diagnostics.push({
          line: 0, severity: 'error',
          message: 'unsupported internal directive: ' + JSON.stringify(unexpected),
        });
      }
    }
  }

  if (workspaceNames.size > 0)
    config.workspaceCount = Math.min(36, Math.max(...workspaceNames.keys()));

  if (diagnostics.some(x => x.severity === 'error'))
    return {config: null, diagnostics};
  return {config, diagnostics};
}
