import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkVersions, currentTarget, json, nativeSourceHash, walk } from './release-lib.mjs';
import { validateBundle } from './artifact-lib.mjs';

checkVersions();
const dir = resolve(process.argv[2] ?? process.cwd());
const pkg = json(join(dir, 'package.json'));
for (const file of [pkg.main, pkg.types, 'LICENSE', 'README.md']) {
  if (!file || !statSync(join(dir, file)).size) throw new Error(`${pkg.name}: missing/empty ${file}`);
}
for (const bin of Object.values(pkg.bin ?? {})) {
  if (!/^#!\/usr\/bin\/env node\r?\n/.test(readFileSync(join(dir, bin), 'utf8'))) throw new Error(`${bin}: missing Node shebang`);
}
if (pkg.files.includes('java') && !walk(join(dir, 'java')).some(file => file.endsWith('.java'))) throw new Error('Missing Java modules');
if (pkg.name === '@izakyl/blockwright-client') {
  const manifest = json(join(dir, 'dist/bundle-manifest.json'));
  validateBundle(manifest, join(dir, 'dist'), { version: pkg.version, sourceHash: nativeSourceHash() });
  if (process.platform !== 'win32') accessSync(join(dir, 'dist', manifest.targets[currentTarget()].executable), constants.X_OK);
}
console.error(`${pkg.name}: package inputs verified`);
