import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkVersions, json, nativeSourceHash, sha256, walk } from './release-lib.mjs';

checkVersions();
const dir = resolve(process.argv[2] ?? process.cwd());
const pkg = json(join(dir, 'package.json'));
for (const file of [pkg.main, pkg.types, 'LICENSE', 'README.md']) {
  if (!file || !statSync(join(dir, file)).size) throw new Error(`${pkg.name}: missing/empty ${file}`);
}
for (const bin of Object.values(pkg.bin ?? {})) {
  if (!readFileSync(join(dir, bin), 'utf8').startsWith('#!/usr/bin/env node\n')) throw new Error(`${bin}: missing Node shebang`);
}
if (pkg.files.includes('java') && !walk(join(dir, 'java')).some(file => file.endsWith('.java'))) throw new Error('Missing Java modules');
if (pkg.name === '@izakyl/blockwright-client') {
  const manifest = json(join(dir, 'dist/bundle-manifest.json'));
  if (manifest.version !== pkg.version || manifest.sourceHash !== nativeSourceHash()) throw new Error('Native bundle is stale; run npm run build:release');
  const expectedJars = [`blockwright-neoforge-agent-${pkg.version}.jar`, `blockwright-coverage-${pkg.version}.jar`].sort();
  const jars = readdirSync(join(dir, 'dist/agents')).sort();
  if (JSON.stringify(jars) !== JSON.stringify(expectedJars)) throw new Error('Missing or unexpected bundled JARs');
  for (const file of ['blockwright', ...expectedJars.map(name => `agents/${name}`)]) {
    if (!manifest.files[file] || sha256(join(dir, 'dist', file)) !== manifest.files[file]) throw new Error(`Invalid bundle: ${file}`);
  }
  for (const [file, digest] of Object.entries(manifest.files)) {
    if (sha256(join(dir, 'dist', file)) !== digest) throw new Error(`Bundle modified: ${file}`);
  }
  accessSync(join(dir, 'dist/blockwright'), constants.X_OK);
  if (!walk(join(dir, 'dist/third-party')).length) throw new Error('Missing third-party notices');
}
console.error(`${pkg.name}: package inputs verified`);
