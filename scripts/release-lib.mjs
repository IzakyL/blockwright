import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const order = ['client', 'ui', 'minecraft', 'test', 'mcp'];
export const packageDir = name => join(root, 'packages', `blockwright-${name}`);
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function run(command, args = [], options = {}) {
  return execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
// Include untracked source edits too. Ignore only generated build/cache directories.
export function nativeSourceHash() {
  const hash = createHash('sha256');
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['build', '.gradle', 'dist', 'node_modules', 'run'].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else { hash.update(relative(root, child)); hash.update('\0'); hash.update(readFileSync(child)); }
    }
  };
  for (const dir of ['crates', 'neoforge-agent', 'coverage-report', 'packages/blockwright-client/scripts']) visit(join(root, dir));
  for (const file of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'scripts/release-lib.mjs', 'scripts/build-release.mjs', 'scripts/third-party.mjs']) hash.update(readFileSync(join(root, file)));
  return hash.digest('hex');
}
export function checkVersions() {
  const version = json(join(packageDir('client'), 'package.json')).version;
  for (const name of order) {
    const pkg = json(join(packageDir(name), 'package.json'));
    if (pkg.version !== version) throw new Error(`${pkg.name}: version must be ${version}`);
    for (const deps of [pkg.dependencies, pkg.devDependencies]) {
      for (const [key, value] of Object.entries(deps ?? {})) {
        if (key.startsWith('@izakyl/blockwright-') && value !== version) throw new Error(`${pkg.name}: ${key} must be ${version}`);
      }
    }
  }
  for (const [file, pattern] of [
    ['crates/blockwright/Cargo.toml', /^version = "([^"]+)"/m],
    ['neoforge-agent/gradle.properties', /^mod_version=(.+)$/m],
    ['coverage-report/gradle.properties', /^version=(.+)$/m],
  ]) {
    if (readFileSync(join(root, file), 'utf8').match(pattern)?.[1] !== version) throw new Error(`${file}: version must be ${version}`);
  }
  return version;
}
