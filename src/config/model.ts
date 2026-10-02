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

/** The gestures `bindgesture` understands. sway's spelling, because i3 has none of its own. */
export type GestureName = 'swipe:left' | 'swipe:right';

/** `bindgesture swipe:left workspace next`. Deliberately shaped like `Binding` minus the key. */
export interface GestureBinding {
  gesture: GestureName;
  /** Raw command text, parsed with parseCommands() when the gesture completes. */
  command: string;
  line: number;
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
  /**
   * Which `client.*` keys the config actually set. `colors` is always fully
   * populated from i3's defaults, so it cannot distinguish a colour the user
   * asked for from one they never mentioned; chrome that falls back to the
   * desktop accent needs that distinction. See effectiveColors().
   */
  specifiedColors: ReadonlySet<keyof Colors>;
  defaultBorder: BorderStyle;
  defaultFloatingBorder: BorderStyle;
  floatingModifier: 'Mod4' | 'Mod1' | 'none';
  focusWrapping: 'yes' | 'no' | 'force' | 'workspace';
  workspaceAutoBackAndForth: boolean;
  /**
   * i3's default is yes, so a config that never mentions it still wants it. Maps to
   * org.gnome.desktop.wm.preferences focus-mode = sloppy, which is Mutter's own focus-follows-mouse and
   * has i3's semantics: the window under the pointer takes focus, empty desktop changes nothing.
   */
  focusFollowsMouse: boolean;
  /**
   * i3's default is `output`: when focus moves to another output the pointer follows.
   *
   * Not cosmetic. With focus-mode sloppy and no warp, the stationary pointer's window would take focus
   * straight back and every keyboard output command would fight the mouse. The two are a pair.
   */
  mouseWarping: 'output' | 'none';
  /**
   * `bindgesture <swipe:left|swipe:right> <command>`, by gesture. Empty unless the config says otherwise.
   *
   * Not an i3 directive: i3 has no gesture syntax at all, so this borrows sway's, the way `launcher` is
   * this project's own addition. Empty is the normal state and means a swipe does nothing -- the design
   * never hardcodes a direction, so which way `workspace next` lies is the user's config to write.
   */
  gestures: Map<GestureName, GestureBinding>;
  /** bar { strip_workspace_numbers }: render pills without the leading number. */
  stripWorkspaceNumbers: boolean;
  /** Workspace number → full configured name, e.g. 1 → "1:I". */
  workspaceNames: Map<number, string>;
  /** Largest workspace number the config references (1..36); 0 when it references none. */
  workspaceCount: number;
  /**
   * `workspace N output <names>`: zero-based workspace index → the outputs it prefers, in order, with
   * the config line that said so. Names are resolved against the live connector list by the engine,
   * not here: at parse time no display is known, and a config written on another machine must load.
   */
  workspaceOutputs: Map<number, {names: string[]; line: number}>;
}

/** i3's default colours (client.* directives override them). */
export const DEFAULT_COLORS: Colors = {
  focused: {border: '#4c7899', background: '#285577', text: '#ffffff', indicator: '#2e9ef4', childBorder: '#285577'},
  focusedInactive: {border: '#333333', background: '#5f676a', text: '#ffffff', indicator: '#484e50', childBorder: '#5f676a'},
  unfocused: {border: '#333333', background: '#222222', text: '#888888', indicator: '#292d2e', childBorder: '#222222'},
  urgent: {border: '#2f343a', background: '#900000', text: '#ffffff', indicator: '#900000', childBorder: '#900000'},
};
