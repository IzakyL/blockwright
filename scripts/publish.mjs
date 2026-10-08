// Intentionally separate from local verification: this command writes to npm.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { root, order, packageDir, json, run, checkVersions, sha256 } from './release-lib.mjs';
const version = checkVersions();
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the Release workflow to publish');
assert.equal(process.env.GITHUB_REF, `refs/tags/v${version}`, 'Release ref must match the package version');
const verified = json(join(root, 'release/verified.json'));
assert.equal(verified.version, version);
const expected = order.map(name => `${json(join(packageDir(name), "package.json")).name.slice(1).replace("/", "-")}-${version}.tgz`);
assert.deepEqual(verified.archives, expected);
for (const file of expected) assert.equal(sha256(join(root, 'release', file)), verified.sha256[file], `Archive changed: ${file}`);
for (const file of expected) run('npm', ['publish', join(root, 'release', file), '--access', 'public', '--registry', 'https://registry.npmjs.org/', '--tag', version.includes('-') ? 'next' : 'latest']);
