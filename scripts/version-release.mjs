import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, order, packageDir, json, run, checkVersions } from './release-lib.mjs';
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version ?? '')) throw new Error('Usage: npm run version:release -- 0.1.1');
checkVersions();
for (const name of order) {
  const path = join(packageDir(name), 'package.json');
  const pkg = json(path); pkg.version = version;
  for (const deps of [pkg.dependencies, pkg.devDependencies]) {
    for (const key of Object.keys(deps ?? {})) if (key.startsWith('@izakyl/blockwright-')) deps[key] = version;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}
for (const [file, pattern, value] of [
  ['crates/blockwright/Cargo.toml', /^version = "[^"]+"/m, `version = "${version}"`],
  ['neoforge-agent/gradle.properties', /^mod_version=.+$/m, `mod_version=${version}`],
  ['coverage-report/gradle.properties', /^version=.+$/m, `version=${version}`],
]) {
  const path = join(root, file); writeFileSync(path, readFileSync(path, 'utf8').replace(pattern, value));
}
run('npm', ['install', '--package-lock-only', '--ignore-scripts']);
run('cargo', ['metadata', '--format-version', '1'], { stdio: 'ignore' });
console.log(`Updated all package versions to ${version}; review the diff and update CHANGELOG.md.`);
