export interface WindowEnumeration<W extends object, S extends object, T> {
  workspaceCount(): number;
  workspace(index: number): S | null;
  normalAllMru: T;
  get_tab_list(type: T, workspace: S): readonly W[];
  workspaceIndex(window: W): number;
}

export function existingWindows<W extends object, S extends object, T>(
  source: WindowEnumeration<W, S, T>,
): readonly W[] {
  const result: W[] = [];
  const seen = new Set<W>();
  for (let index = 0; index < source.workspaceCount(); index++) {
    const workspace = source.workspace(index);
    if (!workspace) continue;
    for (const window of source.get_tab_list(source.normalAllMru, workspace)) {
      if (source.workspaceIndex(window) !== index) continue;
      if (seen.has(window)) continue;
      seen.add(window);
      result.push(window);
    }
  }
  return result;
}
