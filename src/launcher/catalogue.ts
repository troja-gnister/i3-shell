import type {BinaryDir, LauncherItem, RawApp} from './model';

/**
 * Merges the two sources into one list: applications first in the order given,
 * then binaries in $PATH order.
 *
 * Dedup is keyed on the lowercased display name, application wins. It is
 * deliberately NOT keyed on a parsed `Exec=`: an exported Flatpak's Exec is
 * `/usr/bin/flatpak run <id>`, so an Exec-basename rule would delete the real
 * `flatpak` binary from the catalogue.
 */
export function buildCatalogue(
  apps: readonly RawApp[],
  binaryDirs: readonly BinaryDir[],
): LauncherItem[] {
  const seen = new Set<string>();
  const items: LauncherItem[] = [];

  for (const app of apps) {
    const key = app.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      source: 'app',
      id: app.id,
      name: app.name,
      genericName: app.genericName,
      keywords: app.keywords,
      icon: app.icon,
      command: app.id,
    });
  }

  for (const dir of binaryDirs) {
    for (const name of dir.names) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        source: 'binary',
        id: `${dir.path}/${name}`,
        name,
        genericName: null,
        keywords: [],
        icon: null,
        command: `${dir.path}/${name}`,
      });
    }
  }

  return items;
}
