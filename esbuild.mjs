import * as esbuild from 'esbuild';
import {cpSync, mkdirSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const test = process.argv.includes('--test');
rmSync('dist', {recursive: true, force: true});
mkdirSync('dist/schemas', {recursive: true});

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'firefox128',
  external: ['gi://*', 'resource://*'],
  define: {__I3SHELL_TEST__: test ? 'true' : 'false'},
  treeShaking: true,
  logLevel: 'warning',
});

cpSync('metadata.json', 'dist/metadata.json');
cpSync('stylesheet.css', 'dist/stylesheet.css');
cpSync('schemas', 'dist/schemas', {recursive: true});
execFileSync('glib-compile-schemas', ['--strict', 'dist/schemas']);
console.log(`built dist/ (${test ? 'TEST build with org.i3shell.Debug' : 'release build'})`);
