import {describe, expect, it} from 'vitest';
import {existingWindows} from '../../../src/shell/windowEnumeration';

const normalAllMru = 47;

interface FakeWorkspace {
  index: number;
}

interface FakeWindow {
  name: string;
  get_workspace(): FakeWorkspace;
}

describe('native window enumeration', () => {
  it('requests each workspace pure MRU list and retains only its owned windows once', () => {
    const workspace0: FakeWorkspace = {index: 0};
    const workspace1: FakeWorkspace = {index: 1};
    const recent0 = {name: 'recent-0', get_workspace: () => workspace0};
    const stickyAt0 = {name: 'sticky-at-0', get_workspace: () => workspace0};
    const older0 = {name: 'older-0', get_workspace: () => workspace0};
    const recent1 = {name: 'recent-1', get_workspace: () => workspace1};
    const tabLists = new Map<FakeWorkspace, FakeWindow[]>([
      [workspace0, [recent0, stickyAt0, older0]],
      [workspace1, [stickyAt0, recent1]],
    ]);
    const calls: Array<readonly [number, FakeWorkspace]> = [];

    expect(existingWindows({
      workspaceCount: () => 3,
      workspace: (index: number) => [workspace0, workspace1, null][index] ?? null,
      normalAllMru,
      get_tab_list: (type: number, workspace: FakeWorkspace) => {
        calls.push([type, workspace]);
        return tabLists.get(workspace) ?? [];
      },
      workspaceIndex: window => window.get_workspace().index,
    })).toEqual([recent0, stickyAt0, older0, recent1]);
    expect(calls).toEqual([
      [normalAllMru, workspace0],
      [normalAllMru, workspace1],
    ]);
  });
});
