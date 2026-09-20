export type Direction = 'left' | 'right' | 'up' | 'down';
export type Layout = 'splith' | 'splitv' | 'tabbed' | 'stacked';

export type WorkspaceTarget =
  | {kind: 'number'; number: number; name: string}
  | {kind: 'name'; name: string}
  | {kind: 'next'}
  | {kind: 'prev'}
  | {kind: 'back_and_forth'};

export type Command =
  | {type: 'exec'; command: string; noStartupId: boolean}
  | {type: 'kill'}
  | {type: 'focus'; target: Direction | 'parent' | 'child' | 'mode_toggle'}
  | {type: 'move'; direction: Direction}
  | {type: 'move_to_workspace'; target: WorkspaceTarget}
  | {type: 'move_position'; position: 'center' | {x: number; y: number}}
  | {type: 'split'; orientation: 'h' | 'v' | 'toggle'}
  | {type: 'layout'; layout: Layout}
  | {type: 'layout_toggle'; cycle: 'split' | 'all' | Layout[]}
  | {type: 'fullscreen'; action: 'toggle' | 'enable' | 'disable'}
  | {type: 'floating'; action: 'toggle' | 'enable' | 'disable'}
  | {type: 'workspace'; target: WorkspaceTarget}
  | {type: 'resize'; action: 'grow' | 'shrink'; dimension: 'width' | 'height'; px: number; ppt: number | null}
  | {type: 'resize_set'; width: number; height: number}
  | {type: 'border'; style: 'pixel' | 'normal' | 'none' | 'toggle'; width: number}
  | {type: 'mode'; name: string}
  | {type: 'reload'}
  | {type: 'restart'}
  | {type: 'nop'; text: string}
  | {type: 'unknown'; text: string};

export interface CommandParseResult {
  commands: Command[];
  /** Human-readable problems; the caller prefixes the config line number. */
  diagnostics: string[];
}
