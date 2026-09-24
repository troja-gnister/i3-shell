import {describe, it, expect} from 'vitest';
import {initialState, reduce} from '../../../src/launcher/session';
import type {LauncherAction, LauncherState} from '../../../src/launcher/session';
import type {LauncherItem} from '../../../src/launcher/model';

const item = (name: string, patch: Partial<LauncherItem> = {}): LauncherItem => ({
  source: 'app', id: name, name, genericName: null, keywords: [], icon: null, command: name, ...patch,
});
const ITEMS = [item('Firefox'), item('Files'), item('htop', {source: 'binary', id: '/usr/bin/htop', command: '/usr/bin/htop'})];

const run = (actions: readonly LauncherAction[], items = ITEMS, recency: string[] = []) => {
  let state: LauncherState = initialState(items, recency);
  let effect = null;
  for (const action of actions) ({state, effect} = reduce(state, action));
  return {state, effect};
};
const type = (text: string): LauncherAction[] => [...text].map(ch => ({kind: 'type', char: ch} as const));

describe('launcher reducer', () => {
  it('starts with everything listed and the first item selected', () => {
    const {state} = run([]);
    expect(state.query).toBe('');
    expect(state.visible.map(i => i.name)).toEqual(['Files', 'Firefox', 'htop']);
    expect(state.selected).toBe(0);
  });

  it('filters as characters arrive and resets the selection to the top', () => {
    const {state} = run([...type('fi'), {kind: 'down'}, ...type('r')]);
    expect(state.query).toBe('fir');
    expect(state.visible.map(i => i.name)).toEqual(['Firefox']);
    expect(state.selected).toBe(0);
  });

  it('moves the selection down and up without leaving the list', () => {
    expect(run([{kind: 'down'}]).state.selected).toBe(1);
    expect(run([{kind: 'down'}, {kind: 'down'}, {kind: 'down'}]).state.selected).toBe(2);
    expect(run([{kind: 'up'}]).state.selected).toBe(0);
    expect(run([{kind: 'down'}, {kind: 'up'}]).state.selected).toBe(0);
  });

  it('backspaces a character', () => {
    const {state} = run([...type('fir'), {kind: 'backspace'}]);
    expect(state.query).toBe('fi');
  });

  it('completes the query to the selected item', () => {
    const {state} = run([...type('f'), {kind: 'down'}, {kind: 'complete'}]);
    expect(state.query).toBe('Firefox');
  });

  it('completing with nothing selected leaves the query alone', () => {
    const {state} = run([...type('zzz'), {kind: 'complete'}]);
    expect(state.query).toBe('zzz');
  });

  it('accepts the selected item', () => {
    const {effect} = run([...type('ht'), {kind: 'accept'}]);
    expect(effect).toEqual({kind: 'launch', item: ITEMS[2], inTerminal: false});
  });

  it('accepts the selected item into a terminal', () => {
    const {effect} = run([...type('ht'), {kind: 'acceptInTerminal'}]);
    expect(effect).toEqual({kind: 'launch', item: ITEMS[2], inTerminal: true});
  });

  it('runs the typed text verbatim when nothing matches', () => {
    const {effect} = run([...type('mycmd --flag')]);
    expect(effect).toBe(null);
    const {effect: accepted} = run([...type('mycmd --flag'), {kind: 'accept'}]);
    expect(accepted).toEqual({kind: 'exec', command: 'mycmd --flag', inTerminal: false});
  });

  it('runs the typed text in a terminal when nothing matches', () => {
    const {effect} = run([...type('mycmd'), {kind: 'acceptInTerminal'}]);
    expect(effect).toEqual({kind: 'exec', command: 'mycmd', inTerminal: true});
  });

  it('accepts a query with surrounding whitespace as the trimmed command', () => {
    // The fallthrough command is `state.query.trim()`, and the untrimmed text
    // reaches /bin/sh -c: `  htop  ` would be a leading-space command, which
    // some shells and every `<term> -e` wrapper handle differently.
    const {effect} = run([...type('  mycmd  '), {kind: 'accept'}]);
    expect(effect).toEqual({kind: 'exec', command: 'mycmd', inTerminal: false});
  });

  it('does nothing when accepting an empty query with no items', () => {
    const {effect} = run([{kind: 'accept'}], []);
    expect(effect).toEqual({kind: 'dismiss'});
  });

  it('dismisses', () => {
    expect(run([{kind: 'dismiss'}]).effect).toEqual({kind: 'dismiss'});
  });

  it('orders the initial list by recency', () => {
    // The recency list is keyed on item.id, not on the display name -- for a
    // binary that is its absolute path. Names are not unique across a
    // catalogue; ids are.
    const {state} = run([], ITEMS, ['/usr/bin/htop']);
    expect(state.visible.map(i => i.name)).toEqual(['htop', 'Files', 'Firefox']);
  });

  it('keeps the selection at zero when nothing is listed', () => {
    const {state} = run([...type('zzz'), {kind: 'down'}]);
    expect(state.visible).toEqual([]);
    expect(state.selected).toBe(0);
  });
});
