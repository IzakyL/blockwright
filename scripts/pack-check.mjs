import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { root, order, packageDir, run, json, checkVersions, sha256, currentTarget } from './release-lib.mjs';
import { normalizeLinuxDriverMode, verifyLinuxDriverMode } from './tar-mode.mjs';

const version = checkVersions();
const output = join(root, 'release');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'blockwright-package-check-'));
try {
  const archives = [];
  for (const name of order) {
    run('npm', ['run', 'prepack'], { cwd: packageDir(name) });
    const raw = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], { cwd: packageDir(name), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    const info = Array.isArray(raw) ? raw[0] : raw.name ? raw : Object.values(raw)[0];
    const paths = new Set(info.files.map(f => f.path));
    const pkg = json(join(packageDir(name), 'package.json'));
    for (const file of [pkg.main, pkg.types, 'LICENSE', 'README.md', ...Object.values(pkg.bin ?? {})]) assert(paths.has(file), `${pkg.name}: missing ${file}`);
    for (const file of paths) assert(!/\.test\.|\.tsbuildinfo|(^|\/)\.env|node_modules\//.test(file), `Unexpected package file: ${file}`);
    if (pkg.files.includes('java')) assert([...paths].some(f => f.endsWith('.java')));
    const archive = join(scratch, info.filename);
    if (name === 'client') {
      normalizeLinuxDriverMode(archive);
      verifyLinuxDriverMode(archive);
    }
    archives.push(archive);
  }
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...archives, '@playwright/test@1.60.0'], { cwd: consumer });
  cpSync(join(root, 'scripts/package-smoke.mjs'), join(consumer, 'smoke.mjs'));
  run('node', ['smoke.mjs'], { cwd: consumer, timeout: 60_000 });
  cpSync(join(root, 'examples/playwright/smoke.spec.ts'), join(consumer, 'smoke.spec.ts'));
  writeFileSync(join(consumer, 'types.mts'), order.map(name => `import * as ${name} from '@izakyl/blockwright-${name}'; void ${name};`).join('\n'));
  run('node', [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts', 'smoke.spec.ts'], { cwd: consumer });
  for (const archive of archives) cpSync(archive, join(output, basename(archive)));
  const bundle = json(join(packageDir('client'), 'dist/bundle-manifest.json'));
  writeFileSync(join(output, 'verified.json'), JSON.stringify({ schemaVersion: 1, version, sourceHash: bundle.sourceHash,
    targets: Object.keys(bundle.targets).sort(), verifiedOn: currentTarget(), archives: archives.map(path => basename(path)),
    sha256: Object.fromEntries(archives.map(path => [basename(path), sha256(path)])) }, null, 2) + '\n');
  console.log(`All ${archives.length} archives verified outside the workspace; ready in release/.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
