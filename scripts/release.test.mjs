import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { root, packageDir } from './release-lib.mjs';

test('release checks reject missing, stale and modified native artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blockwright-release-negative-'));
  const check = () => spawnSync(process.execPath, [join(root, 'scripts/check-package.mjs'), dir], { encoding: 'utf8' });
  try {
    cpSync(packageDir('client'), dir, { recursive: true });
    assert.equal(check().status, 0, 'baseline bundle must pass before negative checks');
    const path = join(dir, 'dist/bundle-manifest.json');
    const original = readFileSync(path, 'utf8');
    const manifest = JSON.parse(original);
    manifest.sourceHash = 'stale';
    writeFileSync(path, JSON.stringify(manifest));
    assert.match(check().stderr, /Native bundle is stale/);
    writeFileSync(path, original);
    const jar = join(dir, `dist/agents/blockwright-neoforge-agent-${manifest.version}.jar`);
    const bytes = readFileSync(jar);
    writeFileSync(jar, 'invalid jar');
    assert.match(check().stderr, /Invalid bundle/);
    writeFileSync(jar, bytes);
    rmSync(jar);
    assert.match(check().stderr, /Missing or unexpected bundled JARs/);
    writeFileSync(jar, bytes);
    writeFileSync(join(dir, 'dist/agents/old-agent.jar'), 'old jar');
    assert.match(check().stderr, /Missing or unexpected bundled JARs/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
