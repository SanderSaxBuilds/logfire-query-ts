// Builds dist/esm (ES modules) and dist/cjs (CommonJS) with the TypeScript compiler.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsc = require.resolve('typescript/bin/tsc');

rmSync(join(root, 'dist'), { recursive: true, force: true });

const builds = [
  { dir: 'dist/esm', module: 'ES2022', moduleResolution: 'Bundler', type: 'module' },
  { dir: 'dist/cjs', module: 'CommonJS', moduleResolution: 'Node10', type: 'commonjs' },
];

for (const build of builds) {
  execFileSync(
    process.execPath,
    [
      tsc,
      '-p',
      join(root, 'tsconfig.build.json'),
      '--outDir',
      join(root, build.dir),
      '--module',
      build.module,
      '--moduleResolution',
      build.moduleResolution,
    ],
    { stdio: 'inherit' },
  );
  mkdirSync(join(root, build.dir), { recursive: true });
  writeFileSync(join(root, build.dir, 'package.json'), JSON.stringify({ type: build.type }, null, 2) + '\n');
}

console.log('built dist/esm and dist/cjs');
