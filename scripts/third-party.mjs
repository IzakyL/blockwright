import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { run, packageDir, root } from './release-lib.mjs';
const out = join(packageDir('client'), 'dist/third-party');
mkdirSync(out, { recursive: true });
cpSync(join(root, 'coverage-report/licenses'), join(out, 'java'), { recursive: true });
cpSync(join(root, 'coverage-report/THIRD_PARTY.md'), join(out, 'JAVA.md'));
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 }));
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
