// Fails when Layer 0 (pure core) imports GNOME modules. Run by `npm run build`.
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';

const roots = ['src/util', 'src/config', 'src/commands', 'src/tree', 'src/runtime', 'src/engine.ts', 'src/global.d.ts'];
const forbidden = [
  /from\s+['"]gi:\/\//,
  /from\s+['"]resource:\/\//,
  /import\s+['"]gi:\/\//,
  /import\s+['"]resource:\/\//,
  /from\s+['"][^'"]*\/shell\//,
  /from\s+['"]\.\/shell\//,
];

function* walk(path) {
  let st;
  try { st = statSync(path); } catch { return; }
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) yield* walk(join(path, entry));
  } else if (path.endsWith('.ts')) {
    yield path;
  }
}

let violations = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    for (const re of forbidden) {
      if (re.test(source)) {
        console.error(`layer0 violation: ${file} matches ${re}`);
        violations++;
      }
    }
  }
}
if (violations > 0) process.exit(1);
console.log('layer0 check ok');
