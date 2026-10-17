import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertNativeBinary, assertStaticWindowsRuntime, writeArtifact } from './artifact-lib.mjs';
import { checkVersions, currentTarget, nativeSourceHash, root, run, targets } from './release-lib.mjs';

const target = currentTarget();
const version = checkVersions();
const sourceHash = nativeSourceHash();
const output = resolve(process.argv[2] ?? join(root, 'release/native', target));
const metadata = targets[target];
mkdirSync(output, { recursive: true });
rmSync(join(output, 'manifest.json'), { force: true });
const env = { ...process.env };
if (target === 'win32-x64') {
  if (env.CARGO_ENCODED_RUSTFLAGS !== undefined) env.CARGO_ENCODED_RUSTFLAGS += '\u001f-C\u001ftarget-feature=+crt-static';
  else env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} -C target-feature=+crt-static`.trim();
}
run('cargo', ['build', '--locked', '--release', '--target', metadata.rustTarget, '--target-dir', join(root, 'target')], { env });
const binary = join(root, 'target', metadata.rustTarget, 'release', metadata.executable);
assertNativeBinary(binary, target);
const reported = run(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
if (reported !== `blockwright ${version}`) throw new Error(`Native version mismatch: ${reported}`);
const runtimeDependencies = target === 'win32-x64' ? assertStaticWindowsRuntime(binary) : undefined;
cpSync(binary, join(output, metadata.executable));
rmSync(join(output, 'third-party'), { recursive: true, force: true });
run('node', ['scripts/third-party.mjs', '--rust-only', '--target', metadata.rustTarget, '--output', join(output, 'third-party')]);
if (nativeSourceHash() !== sourceHash) throw new Error('Source changed during native build; repeat from a stable checkout');
writeArtifact(output, { kind: 'blockwright-native', target, rustTarget: metadata.rustTarget, version, sourceHash,
  ...(runtimeDependencies ? { crt: 'static', runtimeDependencies,
    rustFlags: { rustflags: env.RUSTFLAGS ?? null, encodedRustflags: env.CARGO_ENCODED_RUSTFLAGS ?? null } } : {}) });
if (runtimeDependencies) console.log(`PE system imports: ${runtimeDependencies.join(', ')}`);
console.log(`Built ${target} native artifact in ${output}`);
