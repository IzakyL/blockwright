import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { json, sha256, slashPath, targets, walk } from './release-lib.mjs';

const canonical = value => JSON.stringify([...value].sort());
const safePath = path => typeof path === 'string' && path.length > 0 && !path.includes('\\')
  && !/^[A-Za-z]:|^\//.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

export function artifactFiles(directory) {
  return Object.fromEntries(walk(directory).filter(path => path !== join(directory, 'manifest.json'))
    .map(path => [slashPath(relative(directory, path)), sha256(path)]));
}

export function writeArtifact(directory, metadata) {
  const manifest = { schemaVersion: 1, ...metadata, files: artifactFiles(directory) };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function assertNativeBinary(path, target) {
  const bytes = readFileSync(path);
  if (target === 'linux-x64') {
    if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))
      && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62) return;
  } else if (target === 'win32-x64' && bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
    const pe = bytes.readUInt32LE(60);
    if (pe <= bytes.length - 6 && bytes.toString('ascii', pe, pe + 4) === 'PE\0\0' && bytes.readUInt16LE(pe + 4) === 0x8664) return;
  }
  throw new Error(`Invalid ${target} executable format: ${path}`);
}

/** Read the PE import directory directly; no Visual Studio tools are required for verification. */
export function peImports(path) {
  assertNativeBinary(path, 'win32-x64');
  const bytes = readFileSync(path);
  const pe = bytes.readUInt32LE(60);
  const optional = pe + 24;
  if (bytes.length < optional + 128 || bytes.readUInt16LE(optional) !== 0x20b) throw new Error(`Missing PE32+ optional header: ${path}`);
  const sectionTable = optional + bytes.readUInt16LE(pe + 20);
  const sections = Array.from({ length: bytes.readUInt16LE(pe + 6) }, (_, index) => sectionTable + index * 40);
  const offset = rva => {
    for (const section of sections) {
      if (section + 40 > bytes.length) throw new Error('Truncated PE section table');
      const start = bytes.readUInt32LE(section + 12);
      const length = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= start && rva - start < length) return bytes.readUInt32LE(section + 20) + rva - start;
    }
    throw new Error(`Unmapped PE import RVA: ${rva}`);
  };
  const imports = new Set();
  const rva = bytes.readUInt32LE(optional + 120);
  if (rva) for (let entry = offset(rva); entry + 20 <= bytes.length; entry += 20) {
    const name = bytes.readUInt32LE(entry + 12);
    if (!name) return [...imports].sort();
    const start = offset(name);
    const end = bytes.indexOf(0, start);
    if (end < start) throw new Error('Unterminated PE import name');
    imports.add(bytes.toString('ascii', start, end).toLowerCase());
  }
  if (rva) throw new Error('Unterminated PE import directory');
  return [];
}

export function assertStaticWindowsRuntime(path) {
  const imports = peImports(path);
  const external = imports.filter(name => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(name));
  if (external.length) throw new Error(`Windows native artifact requires an external MSVC runtime: ${external.join(', ')}; rebuild with +crt-static`);
  return imports;
}

function verifyFiles(directory, files, actual) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) throw new Error('Missing artifact file hashes');
  for (const [file, digest] of Object.entries(files)) {
    if (!safePath(file) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid manifest entry: ${file}`);
    const path = join(directory, file);
    if (!statSync(path).isFile() || !statSync(path).size || sha256(path) !== digest) throw new Error(`Invalid bundle: ${file}`);
  }
  if (canonical(Object.keys(files)) !== canonical(actual)) throw new Error('Missing or unexpected artifact files');
}

export function validateArtifact(directory, expected) {
  const manifest = json(join(directory, 'manifest.json'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== expected.kind) throw new Error(`Invalid artifact schema: ${directory}`);
  if (manifest.version !== expected.version || manifest.sourceHash !== expected.sourceHash) throw new Error(`Stale or mixed-source artifact: ${directory}`);
  if (expected.target && (manifest.target !== expected.target || manifest.rustTarget !== targets[expected.target]?.rustTarget)) throw new Error(`Artifact target mismatch: ${directory}`);
  verifyFiles(directory, manifest.files, walk(directory).filter(path => path !== join(directory, 'manifest.json')).map(path => slashPath(relative(directory, path))));
  if (expected.kind === 'blockwright-native') {
    const executable = targets[expected.target].executable;
    if (!manifest.files[executable] || !manifest.files['third-party/RUST.md']) throw new Error(`Incomplete native artifact: ${expected.target}`);
    assertNativeBinary(join(directory, executable), expected.target);
    if (expected.target === 'win32-x64') {
      const imports = assertStaticWindowsRuntime(join(directory, executable));
      if (manifest.runtimeDependencies && canonical(manifest.runtimeDependencies) !== canonical(imports)) throw new Error('Windows runtime dependency inventory mismatch');
    }
  } else {
    for (const name of agentNames(expected.version)) if (!manifest.files[`agents/${name}`]) throw new Error(`Missing agent: ${name}`);
    if (!manifest.files['third-party/JAVA.md']) throw new Error('Missing Java third-party notices');
  }
  return manifest;
}

export const agentNames = version => [`blockwright-neoforge-agent-${version}.jar`, `blockwright-coverage-${version}.jar`].sort();

/** Validate all inputs before copying; a development bundle can deliberately contain one native target. */
export function assembleBundle({ nativeDirectory, agentsDirectory, dist, version, sourceHash, targetNames = Object.keys(targets), complete = true }) {
  if (complete && canonical(targetNames) !== canonical(Object.keys(targets))) throw new Error('A release bundle requires both native targets');
  const artifacts = targetNames.map(target => ({ target, directory: join(nativeDirectory, target),
    manifest: validateArtifact(join(nativeDirectory, target), { kind: 'blockwright-native', version, sourceHash, target }) }));
  const agents = validateArtifact(agentsDirectory, { kind: 'blockwright-agents', version, sourceHash });
  const files = {};
  const copy = (directory, source, destination, digest) => {
    mkdirSync(dirname(join(dist, destination)), { recursive: true });
    cpSync(join(directory, source), join(dist, destination), { preserveTimestamps: false });
    files[destination] = digest;
  };
  for (const artifact of artifacts) {
    for (const [file, digest] of Object.entries(artifact.manifest.files)) {
      const destination = file.startsWith('third-party/')
        ? `third-party/${artifact.target}/${file.slice('third-party/'.length)}` : `native/${artifact.target}/${file}`;
      copy(artifact.directory, file, destination, digest);
      // CI artifact downloads flatten Unix modes. Restore the Linux executable before npm pack.
      if (artifact.target === 'linux-x64' && file === targets[artifact.target].executable) chmodSync(join(dist, destination), 0o755);
    }
  }
  for (const [file, digest] of Object.entries(agents.files)) copy(agentsDirectory, file, file, digest);
  const manifest = { schemaVersion: 2, version, sourceHash, complete,
    targets: Object.fromEntries(targetNames.map(target => [target, { rustTarget: targets[target].rustTarget, executable: `native/${target}/${targets[target].executable}` }])), files };
  validateBundle(manifest, dist, { version, sourceHash, requireComplete: complete });
  writeFileSync(join(dist, 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function validateBundle(manifest, dist, { version, sourceHash, requireComplete = true }) {
  if (manifest.schemaVersion !== 2) throw new Error('Unsupported bundle manifest schema; rebuild the native bundle');
  if (manifest.version !== version || manifest.sourceHash !== sourceHash) throw new Error('Native bundle is stale; run npm run build:release');
  if (!manifest.targets || typeof manifest.targets !== 'object') throw new Error('Missing bundle targets');
  const names = Object.keys(manifest.targets);
  if (requireComplete && (manifest.complete !== true || canonical(names) !== canonical(Object.keys(targets)))) throw new Error('Incomplete native bundle: both linux-x64 and win32-x64 are required');
  for (const target of names) {
    const expected = targets[target];
    const item = manifest.targets[target];
    if (!expected || item.rustTarget !== expected.rustTarget || item.executable !== `native/${target}/${expected.executable}`) throw new Error(`Invalid bundle target: ${target}`);
    if (!manifest.files?.[item.executable] || !manifest.files?.[`third-party/${target}/RUST.md`]) throw new Error(`Incomplete bundle target: ${target}`);
    assertNativeBinary(join(dist, item.executable), target);
    if (target === 'win32-x64') assertStaticWindowsRuntime(join(dist, item.executable));
  }
  if (canonical(readdirSync(join(dist, 'agents'))) !== canonical(agentNames(version))) throw new Error('Missing or unexpected bundled JARs');
  for (const name of agentNames(version)) if (!manifest.files?.[`agents/${name}`]) throw new Error(`Missing bundled JAR hash: ${name}`);
  if (!manifest.files?.['third-party/JAVA.md']) throw new Error('Missing Java third-party notices');
  const actual = ['native', 'agents', 'third-party'].flatMap(dir => walk(join(dist, dir)).map(path => slashPath(relative(dist, path))));
  verifyFiles(dist, manifest.files, actual);
  return manifest;
}
