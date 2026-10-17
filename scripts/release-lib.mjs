import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const order = ['client', 'ui', 'minecraft', 'test', 'mcp', 'cinema'];
export const packageDir = name => join(root, 'packages', `blockwright-${name}`);
export const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const slashPath = path => path.replaceAll('\\', '/');
export const targets = Object.freeze({
  'linux-x64': { platform: 'linux', arch: 'x64', rustTarget: 'x86_64-unknown-linux-gnu', executable: 'blockwright' },
  'win32-x64': { platform: 'win32', arch: 'x64', rustTarget: 'x86_64-pc-windows-msvc', executable: 'blockwright.exe' },
});
export function currentTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!targets[target]) throw new Error(`Unsupported native target: ${target}`);
  return target;
}
// npm.cmd requires a command shell. Invoke npm's JavaScript entrypoint directly instead.
export function npmCommand() {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find(path => path?.endsWith('.js') && existsSync(path));
  if (!cli) throw new Error('Cannot locate npm-cli.js beside Node; run this command through npm');
  return { command: process.execPath, args: [cli] };
}
export function run(command, args = [], options = {}) {
  if (command === 'npm') {
    const npm = npmCommand();
    return execFileSync(npm.command, [...npm.args, ...args], { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
  }
  return execFileSync(command === 'node' ? process.execPath : command, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
}
export function gradle(project, args) {
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  return run(java, ['-Dorg.gradle.appname=gradlew', '-classpath', join(root, project, 'gradle/wrapper/gradle-wrapper.jar'),
    'org.gradle.wrapper.GradleWrapperMain', '-p', join(root, project), ...args]);
}
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Portable path identities and LF text; binary inputs are always hashed byte-for-byte. */
export function hashSources(base, files) {
  const hash = createHash('sha256');
  const textExtensions = new Set(['.rs', '.java', '.gradle', '.kts', '.toml', '.lock', '.properties', '.md', '.mjs', '.js', '.ts', '.json', '.sh', '.bat', '.yml', '.yaml', '.xml', '.txt']);
  for (const file of [...files].sort((a, b) => slashPath(relative(base, a)) < slashPath(relative(base, b)) ? -1 : 1)) {
    const bytes = readFileSync(file);
    hash.update(slashPath(relative(base, file)));
    hash.update('\0');
    hash.update(textExtensions.has(extname(file)) || !extname(file) ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n')) : bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}
// Include untracked source edits too. Ignore only generated build/cache directories.
export function nativeSourceHash() {
  const files = [];
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['build', '.gradle', 'dist', 'node_modules', 'run'].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else files.push(child);
    }
  };
  for (const dir of ['crates', 'neoforge-agent', 'coverage-report', 'packages/blockwright-client/scripts']) visit(join(root, dir));
  for (const file of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.gitattributes', 'scripts/release-lib.mjs', 'scripts/artifact-lib.mjs', 'scripts/build-native.mjs', 'scripts/build-agents.mjs', 'scripts/build-release.mjs', 'scripts/third-party.mjs']) files.push(join(root, file));
  return hashSources(root, files);
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
