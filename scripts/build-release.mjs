import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assembleBundle, validateArtifact } from './artifact-lib.mjs';
import { root, order, packageDir, run, checkVersions, currentTarget, nativeSourceHash, targets } from './release-lib.mjs';

const args = process.argv.slice(2);
const development = args.includes('--development');
const value = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} requires a path`);
  return resolve(args[index + 1]);
};
const known = new Set(['--development', '--native-dir', '--agents-dir']);
for (let index = 0; index < args.length; index++) {
  if (!known.has(args[index])) throw new Error(`Unknown release option: ${args[index]}`);
  if (args[index] !== '--development') index++;
}
const nativeDirectory = value('--native-dir', join(root, 'release/native'));
const agentsDirectory = value('--agents-dir', join(root, 'release/agents'));
const targetNames = development ? [currentTarget()] : Object.keys(targets);
const version = checkVersions();
const sourceHash = nativeSourceHash();
const dist = join(packageDir('client'), 'dist');
// A failed rebuild cannot leave a valid-looking manifest from a previous build.
rmSync(join(dist, 'bundle-manifest.json'), { force: true });
for (const target of targetNames) validateArtifact(join(nativeDirectory, target), { kind: 'blockwright-native', target, version, sourceHash });
validateArtifact(agentsDirectory, { kind: 'blockwright-agents', version, sourceHash });
for (const name of order) rmSync(join(packageDir(name), 'dist'), { recursive: true, force: true });
run('npm', ['run', 'build', '--', '--force']);
if (nativeSourceHash() !== sourceHash) throw new Error('Source changed during bundle assembly');
assembleBundle({ nativeDirectory, agentsDirectory, dist, version, sourceHash, targetNames, complete: !development });
if (!development) for (const name of order) run('node', ['scripts/check-package.mjs', packageDir(name)]);
console.log(development ? 'Development bundle complete for the current platform; prepack will reject this incomplete bundle.'
  : 'Both native targets and canonical JARs assembled. Run npm run pack:check to verify the archives.');
