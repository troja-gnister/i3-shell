import type {LauncherItem} from './model';
import {rankItems} from './match';

export interface LauncherState {
  /** Every item in the catalogue, unfiltered. */
  readonly items: readonly LauncherItem[];
  readonly recency: readonly string[];
  readonly query: string;
  /** The ranked subset the renderer draws. */
  readonly visible: readonly LauncherItem[];
  /** Index into `visible`; 0 when `visible` is empty, which the effects guard against. */
  readonly selected: number;
}

export type LauncherAction =
  | {kind: 'type'; char: string}
  | {kind: 'backspace'}
  | {kind: 'up'}
  | {kind: 'down'}
  | {kind: 'complete'}
  | {kind: 'accept'}
  | {kind: 'acceptInTerminal'}
  | {kind: 'dismiss'};

export type LauncherEffect =
  | {kind: 'launch'; item: LauncherItem; inTerminal: boolean}
  /** dmenu_run's behaviour: with no match, the typed text IS the command. */
  | {kind: 'exec'; command: string; inTerminal: boolean}
  | {kind: 'dismiss'};

export function initialState(
  items: readonly LauncherItem[],
  recency: readonly string[],
): LauncherState {
  return {items, recency, query: '', visible: rankItems(items, '', recency), selected: 0};
}

function requery(state: LauncherState, query: string): LauncherState {
  // The selection returns to the top on every query change: keeping an index
  // across a filter would leave it pointing at an unrelated item.
  return {...state, query, visible: rankItems(state.items, query, state.recency), selected: 0};
}

function selectedItem(state: LauncherState): LauncherItem | null {
  return state.visible[state.selected] ?? null;
}

function accept(state: LauncherState, inTerminal: boolean): {state: LauncherState; effect: LauncherEffect} {
  const item = selectedItem(state);
  if (item) return {state, effect: {kind: 'launch', item, inTerminal}};
  const command = state.query.trim();
  // An empty query with nothing to select is a dismissal, not an empty spawn.
  if (!command) return {state, effect: {kind: 'dismiss'}};
  return {state, effect: {kind: 'exec', command, inTerminal}};
}

export function reduce(
  state: LauncherState,
  action: LauncherAction,
): {state: LauncherState; effect: LauncherEffect | null} {
  switch (action.kind) {
    case 'type':
      return {state: requery(state, state.query + action.char), effect: null};
    case 'backspace':
      return {state: requery(state, state.query.slice(0, -1)), effect: null};
    case 'up':
      return {state: {...state, selected: Math.max(0, state.selected - 1)}, effect: null};
    case 'down':
      return {state: {...state, selected: Math.max(0, Math.min(state.visible.length - 1, state.selected + 1))}, effect: null};
    case 'complete': {
      const item = selectedItem(state);
      return item ? {state: requery(state, item.name), effect: null} : {state, effect: null};
    }
    case 'accept':
      return accept(state, false);
    case 'acceptInTerminal':
      return accept(state, true);
    case 'dismiss':
      return {state, effect: {kind: 'dismiss'}};
  }
}
