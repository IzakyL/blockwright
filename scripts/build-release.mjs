import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { root, order, packageDir, run, checkVersions, nativeSourceHash, sha256, walk } from './release-lib.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Release builds require Linux x64');
const version = checkVersions();
const sourceHash = nativeSourceHash();
for (const name of order) rmSync(join(packageDir(name), 'dist'), { recursive: true, force: true });
run('npm', ['run', 'build']);
run('sh', ['packages/blockwright-client/scripts/build-bundle.sh']);
run('node', ['scripts/third-party.mjs']);
if (nativeSourceHash() !== sourceHash) throw new Error('Source changed during native build; run again from a stable checkout');
const dist = join(packageDir('client'), 'dist');
const files = Object.fromEntries(['blockwright', ...walk(join(dist, 'agents')).map(f => relative(dist, f)), ...walk(join(dist, 'third-party')).map(f => relative(dist, f))].map(file => [file, sha256(join(dist, file))]));
writeFileSync(join(dist, 'bundle-manifest.json'), JSON.stringify({ version, sourceHash, files }, null, 2) + '\n');
for (const name of order) run('node', ['scripts/check-package.mjs', packageDir(name)]);
console.log('Release build complete. Run npm run pack:check to verify the installable archives.');
