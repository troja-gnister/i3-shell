// Runs both tsc programs and reports both, even if the first one fails.
// `tsc -p a && tsc -p b` short-circuits on `&&`: if tsconfig.json is red,
// tsconfig.test.json never runs at all, and its errors go unreported. This
// script always runs both and fails the command if either one does.
import {spawnSync} from 'node:child_process';

const programs = ['tsconfig.json', 'tsconfig.test.json'];
let failed = false;

for (const project of programs) {
  console.log(`> tsc --noEmit -p ${project}`);
  const result = spawnSync('npx', ['tsc', '--noEmit', '-p', project], {stdio: 'inherit'});
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
