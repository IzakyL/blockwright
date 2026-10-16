import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { run, packageDir, root } from './release-lib.mjs';
const args = process.argv.slice(2);
const known = new Set(['--rust-only', '--java-only', '--target', '--output']);
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (!known.has(name)) throw new Error(`Unknown license option: ${name}`);
  if (name === '--target' || name === '--output') {
    if (!args[++index] || args[index].startsWith('--')) throw new Error(`${name} requires a value`);
  }
}
if (args.includes('--rust-only') && args.includes('--java-only')) throw new Error('Select one license inventory or both by default');
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const out = option('--output') ?? join(packageDir('client'), 'dist/third-party');
mkdirSync(out, { recursive: true });
if (!args.includes('--rust-only')) {
  cpSync(join(root, 'coverage-report/licenses'), join(out, 'java'), { recursive: true });
  cpSync(join(root, 'coverage-report/THIRD_PARTY.md'), join(out, 'JAVA.md'));
}
if (!args.includes('--java-only')) {
  const target = option('--target');
  const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', ...(target ? ['--filter-platform', target] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 }));
  const lines = ['# Rust dependency inventory', '', 'Conservative inventory from Cargo.lock; includes target-specific and build dependencies.', 'License texts supplied by each crate are preserved in rust/<crate>-<version>/.', 'Source archives: https://crates.io/crates/<crate>/<version> (the original license terms apply).', '', '| Crate | Version | License expression | Source |', '| --- | --- | --- | --- |'];
  for (const pkg of metadata.packages.filter(p => p.source).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = dirname(pkg.manifest_path);
    const target = join(out, 'rust', `${pkg.name}-${pkg.version}`);
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(dir)) {
      if (/^(licen[sc]e|notice|copying|copyright)([._-]|$)/i.test(entry)) cpSync(join(dir, entry), join(target, entry), { recursive: true });
    }
    if (pkg.license_file) cpSync(join(dir, pkg.license_file), join(target, 'DECLARED-LICENSE'));
    writeFileSync(join(target, 'SOURCE.txt'), `${pkg.name} ${pkg.version}\n${pkg.license ?? 'See DECLARED-LICENSE'}\nhttps://crates.io/crates/${pkg.name}/${pkg.version}\n${pkg.repository ?? ''}\n`);
    lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license ?? 'See license file'} | https://crates.io/crates/${pkg.name}/${pkg.version} |`);
  }
  writeFileSync(join(out, 'RUST.md'), lines.join('\n') + '\n');
}
