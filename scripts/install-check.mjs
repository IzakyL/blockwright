import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { currentTarget, json, order, root, run, sha256 } from './release-lib.mjs';

const release = resolve(process.argv[2] ?? join(root, 'release'));
const verified = json(join(release, 'verified.json'));
assert.equal(verified.schemaVersion, 1);
assert.deepEqual(verified.targets, ['linux-x64', 'win32-x64']);
assert.equal(verified.archives.length, order.length);
assert.equal(new Set(verified.archives).size, order.length);
const archives = verified.archives.map(name => {
  assert.equal(basename(name), name, 'Archive names must not escape release/');
  assert(name.endsWith('.tgz'));
  const path = join(release, name);
  assert.equal(sha256(path), verified.sha256[name], `Archive changed: ${name}`);
  return path;
});
const lock = json(join(root, 'package-lock.json'));
const typescript = lock.packages?.['node_modules/typescript']?.version;
const nodeTypes = lock.packages?.['node_modules/@types/node']?.version;
assert(typescript && nodeTypes, 'The lockfile must pin TypeScript and Node declarations for consumer validation');
const scratch = mkdtempSync(join(tmpdir(), 'blockwright-install-check-'));
try {
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives, '@playwright/test@1.60.0', `typescript@${typescript}`, `@types/node@${nodeTypes}`], { cwd: scratch });
  cpSync(join(root, 'scripts/package-smoke.mjs'), join(scratch, 'smoke.mjs'));
  run('node', ['smoke.mjs'], { cwd: scratch, timeout: 60_000 });
  cpSync(join(root, 'examples/playwright/smoke.spec.ts'), join(scratch, 'smoke.spec.ts'));
  writeFileSync(join(scratch, 'types.mts'), order.map(name => `import * as ${name} from '@izakyl/blockwright-${name}'; void ${name};`).join('\n'));
  run('node', [join(scratch, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts', 'smoke.spec.ts'], { cwd: scratch });
  console.log(`Installed package declarations and Playwright example compiled with TypeScript ${typescript}, @types/node ${nodeTypes}.`);
  console.log(`Verified the same six archives on ${currentTarget()}, Node ${process.versions.node}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
