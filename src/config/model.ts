export interface Diagnostic {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface Binding {
  /** Mutter accelerator string, e.g. "<Super><Shift>semicolon". */
  accel: string;
  /** The combination as written after variable substitution, e.g. "Mod4+Shift+semicolon". */
  combo: string;
  /** Raw command text, parsed with parseCommands() when the key is pressed. */
  command: string;
  noRepeat: boolean;
  line: number;
}

export interface Mode {
  name: string;
  bindings: Binding[];
}

export interface Criteria {
  class?: RegExp;
  instance?: RegExp;
  title?: RegExp;
  app_id?: RegExp;
  window_role?: RegExp;
  floating?: boolean;
  tiling?: boolean;
}

export interface Rule {
  criteria: Criteria;
  command: string;
  line: number;
}

export interface ColorSet {
  border: string;
  background: string;
  text: string;
  indicator: string;
  childBorder: string;
}

export interface Colors {
  focused: ColorSet;
  focusedInactive: ColorSet;
  unfocused: ColorSet;
  urgent: ColorSet;
}

export interface BorderStyle {
  style: 'pixel' | 'normal' | 'none';
  width: number;
}

export interface Config {
  /** Always contains "default". */
  modes: Map<string, Mode>;
  rules: Rule[];
  colors: Colors;
  defaultBorder: BorderStyle;
  defaultFloatingBorder: BorderStyle;
  floatingModifier: 'Mod4' | 'Mod1' | 'none';
  focusWrapping: 'yes' | 'no' | 'force' | 'workspace';
  workspaceAutoBackAndForth: boolean;
  /** Workspace number → full configured name, e.g. 1 → "1:I". */
  workspaceNames: Map<number, string>;
  /** Largest workspace number the config references (1..36); 0 when it references none. */
  workspaceCount: number;
}

/** i3's default colours (client.* directives override them). */
export const DEFAULT_COLORS: Colors = {
  focused: {border: '#4c7899', background: '#285577', text: '#ffffff', indicator: '#2e9ef4', childBorder: '#285577'},
  focusedInactive: {border: '#333333', background: '#5f676a', text: '#ffffff', indicator: '#484e50', childBorder: '#5f676a'},
  unfocused: {border: '#333333', background: '#222222', text: '#888888', indicator: '#292d2e', childBorder: '#222222'},
  urgent: {border: '#2f343a', background: '#900000', text: '#ffffff', indicator: '#900000', childBorder: '#900000'},
};
