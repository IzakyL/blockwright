import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeArtifact } from './artifact-lib.mjs';
import { checkVersions, gradle, nativeSourceHash, root, run } from './release-lib.mjs';

const version = checkVersions();
const sourceHash = nativeSourceHash();
const args = process.argv.slice(2);
for (const arg of args) if (arg.startsWith('--') && arg !== '--offline') throw new Error(`Unknown Java build option: ${arg}`);
const paths = args.filter(arg => !arg.startsWith('--'));
if (paths.length > 1) throw new Error('Usage: build-agents.mjs [OUTPUT] [--offline]');
const output = resolve(paths[0] ?? join(root, 'release/agents'));
mkdirSync(output, { recursive: true });
rmSync(join(output, 'manifest.json'), { force: true });
rmSync(join(output, 'agents'), { recursive: true, force: true });
mkdirSync(join(output, 'agents'));
rmSync(join(output, 'third-party'), { recursive: true, force: true });
for (const [project, name] of [['neoforge-agent', `blockwright-neoforge-agent-${version}.jar`], ['coverage-report', `blockwright-coverage-${version}.jar`]]) {
  gradle(project, ['--no-daemon', ...(args.includes('--offline') ? ['--offline'] : []), 'clean', 'build']);
  const jar = join(root, project, 'build/libs', name);
  if (!statSync(jar).size) throw new Error(`Missing agent artifact: ${jar}`);
  cpSync(jar, join(output, 'agents', name));
}
run('node', ['scripts/third-party.mjs', '--java-only', '--output', join(output, 'third-party')]);
if (nativeSourceHash() !== sourceHash) throw new Error('Source changed during Java build; repeat from a stable checkout');
writeArtifact(output, { kind: 'blockwright-agents', version, sourceHash });
console.log(`Built canonical Java artifacts in ${output}`);
