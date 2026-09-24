import {describe, it, expect} from 'vitest';
import {rankItems} from '../../../src/launcher/match';
import type {LauncherItem} from '../../../src/launcher/model';

const item = (name: string, patch: Partial<LauncherItem> = {}): LauncherItem => ({
  source: 'app', id: name, name, genericName: null, keywords: [], icon: null, command: name, ...patch,
});
const bin = (name: string): LauncherItem => item(name, {source: 'binary', id: `/usr/bin/${name}`});
const names = (items: readonly LauncherItem[]): string[] => items.map(i => i.name);

describe('rankItems', () => {
  it('returns everything for an empty query, recency first', () => {
    // Equal-length names on purpose: the shorter-name tie-break sits between
    // recency and the alphabetical one, and names of different lengths would
    // let this case pass while the alphabetical rule was broken.
    const items = [item('Alpha'), item('Bravo'), item('Delta')];
    expect(names(rankItems(items, '', ['Delta']))).toEqual(['Delta', 'Alpha', 'Bravo']);
  });

  it('orders exact, prefix, word-prefix, substring, keyword', () => {
    // Each fixture reaches exactly ONE tier, so the case cannot pass by accident:
    //   'ex'             -- equals the query                        tier 0
    //   'Example Prefix' -- starts with it                          tier 1
    //   'Word ex Here'   -- a word starts with it, the name does not tier 2
    //   'complex'        -- contains it, no word starts with it     tier 3
    //   'Keyword Only'   -- the NAME does not contain 'ex' at all   tier 4
    const items = [
      item('Keyword Only', {keywords: ['ex']}),
      item('Example Prefix'),
      item('complex'),
      item('Word ex Here'),
      item('ex'),
    ];
    expect(names(rankItems(items, 'ex', []))).toEqual([
      'ex',
      'Example Prefix',
      'Word ex Here',
      'complex',
      'Keyword Only',
    ]);
  });

  it('ignores case on both sides', () => {
    expect(names(rankItems([item('Firefox')], 'FIRE', []))).toEqual(['Firefox']);
  });

  it('drops items that match in no tier', () => {
    expect(rankItems([item('Firefox')], 'zzz', [])).toEqual([]);
  });

  it('matches a generic name in the keyword tier', () => {
    const items = [item('Files', {genericName: 'File Manager'})];
    expect(names(rankItems(items, 'manager', []))).toEqual(['Files']);
  });

  it('breaks a tier tie on recency first', () => {
    // Equal-length names whose alphabetical order is the OPPOSITE of the
    // asserted one, so neither the length rule nor the alphabetical rule can
    // produce this result. Only recency can.
    const items = [item('Fireball'), item('Firebird')];
    expect(names(rankItems(items, 'fire', ['Firebird']))).toEqual(['Firebird', 'Fireball']);
  });

  it('breaks a tie on application before binary when recency is silent', () => {
    const items = [bin('code'), item('code')];
    expect(rankItems(items, 'code', []).map(i => i.source)).toEqual(['app', 'binary']);
  });

  it('breaks a remaining tie on the shorter name', () => {
    // An empty query puts both in one tier with no recency and the same
    // source, so the length rule is the only thing left -- and it points the
    // opposite way to the alphabetical rule that follows it.
    const items = [item('Antelope'), item('Zebra')];
    expect(names(rankItems(items, '', []))).toEqual(['Zebra', 'Antelope']);
  });

  it('ranks an exact match above a prefix match, even one the user launched recently', () => {
    // Length cannot separate these: an exact match's name IS the query, so it
    // is always the shortest prefix match too. Recency is the only lever that
    // can point the other way, so it is what this test uses. Collapse tier 0
    // into tier 1 and recency puts 'Example' first.
    const items = [item('Example'), item('ex')];
    expect(names(rankItems(items, 'ex', ['Example']))).toEqual(['ex', 'Example']);
  });

  it('ranks a substring match above a keyword-only match, despite being longer', () => {
    // 'complexity zz' contains 'ex' but no word starts with it -> substring.
    // 'Aa' matches only through its keyword. Collapse the keyword tier into
    // the substring tier and the length rule puts the 2-character 'Aa' first.
    const items = [item('Aa', {keywords: ['ex']}), item('complexity zz')];
    expect(names(rankItems(items, 'ex', []))).toEqual(['complexity zz', 'Aa']);
  });

  it('breaks a final tie alphabetically', () => {
    const items = [item('fireb'), item('firea')];
    expect(names(rankItems(items, 'fire', []))).toEqual(['firea', 'fireb']);
  });

  it('does not match a subsequence, because there is no fuzzy matching', () => {
    expect(rankItems([item('Firefox')], 'ffx', [])).toEqual([]);
  });

  it('treats a hyphen as a word boundary, outranking a shorter substring match', () => {
    const items = [item('gnome-disk-utility'), item('xdisk')];
    expect(names(rankItems(items, 'disk', []))).toEqual(['gnome-disk-utility', 'xdisk']);
  });

  it('treats an underscore as a word boundary, outranking a shorter substring match', () => {
    const items = [item('sound_juicer'), item('xjuicer')];
    expect(names(rankItems(items, 'juicer', []))).toEqual(['sound_juicer', 'xjuicer']);
  });

  it('treats a space as a word boundary, outranking a shorter substring match', () => {
    const items = [item('Text Editor'), item('xeditor')];
    expect(names(rankItems(items, 'editor', []))).toEqual(['Text Editor', 'xeditor']);
  });
});
