import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkVersions, currentTarget, hashSources, nativeSourceHash, root, targets } from './release-lib.mjs';
import { agentNames, assembleBundle, assertStaticWindowsRuntime, peImports, validateArtifact, validateBundle, writeArtifact } from './artifact-lib.mjs';
import { linuxDriverEntry, normalizeLinuxDriverMode, verifyLinuxDriverMode } from './tar-mode.mjs';

// Synthetic headers belong only to temporary integrity-test fixtures; they are never build inputs.
function header(target) {
  const bytes = Buffer.alloc(512);
  if (target === 'linux-x64') {
    Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(bytes);
    bytes.writeUInt16LE(62, 18);
  } else {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
    bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(0x20b, 88);
  }
  return bytes;
}
function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture(body) {
  const directory = mkdtempSync(join(tmpdir(), 'blockwright-release-integrity-'));
  const version = checkVersions();
  const sourceHash = nativeSourceHash();
  const nativeDirectory = join(directory, 'native');
  const agentsDirectory = join(directory, 'common');
  for (const [target, metadata] of Object.entries(targets)) {
    const native = join(nativeDirectory, target);
    put(join(native, metadata.executable), header(target));
    chmodSync(join(native, metadata.executable), 0o755);
    put(join(native, 'third-party/RUST.md'), 'Rust license fixture\n');
    writeArtifact(native, { kind: 'blockwright-native', target, rustTarget: metadata.rustTarget, version, sourceHash });
  }
  for (const name of agentNames(version)) put(join(agentsDirectory, 'agents', name), 'JAR integrity fixture\n');
  put(join(agentsDirectory, 'third-party/JAVA.md'), 'Java license fixture\n');
  writeArtifact(agentsDirectory, { kind: 'blockwright-agents', version, sourceHash });
  const dist = join(directory, 'package/dist');
  const options = { nativeDirectory, agentsDirectory, dist, version, sourceHash };
  try { body({ ...options, directory, assemble: extra => assembleBundle({ ...options, ...extra }), validate: manifest => validateBundle(manifest, dist, { version, sourceHash }) }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('target mapping agrees with Node platform identities and refuses unsupported architectures', () => {
  assert.equal(currentTarget('linux', 'x64'), 'linux-x64');
  assert.equal(currentTarget('win32', 'x64'), 'win32-x64');
  assert.throws(() => currentTarget('win32', 'arm64'), /Unsupported native target/);
  assert.throws(() => currentTarget('darwin', 'x64'), /Unsupported native target/);
});

test('source hashes normalize text line endings and root paths, but preserve binary bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'blockwright-source-hash-'));
  try {
    const first = join(directory, 'first'); const second = join(directory, 'second');
    put(join(first, 'nested/a.rs'), 'fn one() {}\nfn two() {}\n');
    put(join(second, 'nested/a.rs'), 'fn one() {}\r\nfn two() {}\r\n');
    assert.equal(hashSources(first, [join(first, 'nested/a.rs')]), hashSources(second, [join(second, 'nested/a.rs')]));
    put(join(first, 'build.gradle'), 'plugins {\n}\n');
    put(join(second, 'build.gradle'), 'plugins {\r\n}\r\n');
    assert.equal(hashSources(first, [join(first, 'build.gradle')]), hashSources(second, [join(second, 'build.gradle')]));
    put(join(first, 'binary.jar'), Buffer.from([13, 10]));
    put(join(second, 'binary.jar'), Buffer.from([10]));
    assert.notEqual(hashSources(first, [join(first, 'binary.jar')]), hashSources(second, [join(second, 'binary.jar')]));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('assembly requires both native targets, matching source/version and one canonical agent set', () => fixture(({ assemble, nativeDirectory, sourceHash, version }) => {
  const manifest = assemble();
  assert.deepEqual(Object.keys(manifest.targets).sort(), ['linux-x64', 'win32-x64']);
  assert(Object.keys(manifest.files).every(path => !path.includes('\\')));
  const path = join(nativeDirectory, 'win32-x64/manifest.json');
  const original = readFileSync(path, 'utf8');
  for (const change of [{ version: `${version}-other` }, { sourceHash: 'stale' }, { target: 'linux-x64' }]) {
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), ...change }));
    assert.throws(() => assemble(), /Stale or mixed-source|target mismatch/);
  }
  writeFileSync(path, original);
  rmSync(join(nativeDirectory, 'win32-x64'), { recursive: true });
  assert.throws(() => assemble(), /ENOENT/);
  assert.throws(() => assemble({ targetNames: ['linux-x64'] }), /both native targets/);
}));

test('package checks reject incomplete, stale, modified and unexpected bundle inputs', () => fixture(({ assemble, directory, dist, version }) => {
  const manifest = assemble();
  const packageDirectory = join(directory, 'package');
  put(join(packageDirectory, 'package.json'), JSON.stringify({ name: '@izakyl/blockwright-client', version, main: 'dist/index.js', types: 'dist/index.d.ts', files: ['dist'] }));
  for (const path of ['dist/index.js', 'dist/index.d.ts', 'LICENSE', 'README.md']) put(join(packageDirectory, path), 'package fixture\n');
  const check = () => spawnSync(process.execPath, [join(root, 'scripts/check-package.mjs'), packageDirectory], { encoding: 'utf8', windowsHide: true });
  assert.equal(check().status, 0, check().stderr);
  const path = join(dist, 'bundle-manifest.json');
  writeFileSync(path, JSON.stringify({ ...manifest, sourceHash: 'stale' }));
  assert.match(check().stderr, /Native bundle is stale/);
  writeFileSync(path, JSON.stringify({ ...manifest, complete: false }));
  assert.match(check().stderr, /Incomplete native bundle/);
  writeFileSync(path, JSON.stringify(manifest));
  const jar = join(dist, 'agents', agentNames(version)[0]);
  const bytes = readFileSync(jar);
  writeFileSync(jar, 'modified');
  assert.match(check().stderr, /Invalid bundle/);
  writeFileSync(jar, bytes);
  rmSync(jar);
  assert.match(check().stderr, /Missing or unexpected bundled JARs/);
  writeFileSync(jar, bytes);
  writeFileSync(join(dist, 'agents/old-agent.jar'), 'old jar');
  assert.match(check().stderr, /Missing or unexpected bundled JARs/);
}));

test('development bundles run one platform layout but cannot pass final validation', () => fixture(({ assemble, validate, dist, version, sourceHash }) => {
  const manifest = assemble({ targetNames: ['win32-x64'], complete: false });
  assert.equal(manifest.complete, false);
  assert.throws(() => validate(manifest), /Incomplete native bundle/);
  assert.equal(validateBundle(manifest, dist, { version, sourceHash, requireComplete: false }), manifest);
}));

test('native executable identity, notice hashes, path traversal and unlisted inputs are checked', () => fixture(({ assemble, validate, nativeDirectory, version, sourceHash, dist }) => {
  const native = join(nativeDirectory, 'win32-x64');
  const expected = { kind: 'blockwright-native', target: 'win32-x64', version, sourceHash };
  const path = join(native, 'manifest.json');
  const original = readFileSync(path, 'utf8');
  put(join(native, 'blockwright.exe'), header('linux-x64'));
  writeArtifact(native, { ...JSON.parse(original), files: undefined });
  assert.throws(() => validateArtifact(native, expected), /executable format/);
  put(join(native, 'blockwright.exe'), header('win32-x64'));
  writeFileSync(path, original);
  const malicious = JSON.parse(original); malicious.files['../escape'] = '0'.repeat(64);
  writeFileSync(path, JSON.stringify(malicious));
  assert.throws(() => validateArtifact(native, expected), /Invalid manifest entry/);
  writeFileSync(path, original);
  const manifest = assemble();
  put(join(dist, 'third-party/win32-x64/RUST.md'), 'changed notices');
  assert.throws(() => validate(manifest), /Invalid bundle/);
}));

test('unlisted native files cannot hide behind a valid manifest', () => fixture(({ assemble, validate, dist }) => {
  const manifest = assemble();
  put(join(dist, 'native/win32-x64/unlisted.dll'), 'unexpected');
  assert.throws(() => validate(manifest), /unexpected artifact files/);
}));

test('Windows release verification rejects imported Visual C++ runtime DLLs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'blockwright-pe-imports-'));
  const path = join(directory, 'fixture.exe');
  try {
    const bytes = Buffer.alloc(1024);
    header('win32-x64').copy(bytes);
    bytes.writeUInt16LE(1, 70); // One section, mapping RVA 0x1000 to file offset 0x200.
    bytes.writeUInt32LE(0x200, 336); bytes.writeUInt32LE(0x1000, 340);
    bytes.writeUInt32LE(0x200, 344); bytes.writeUInt32LE(0x200, 348);
    bytes.writeUInt32LE(0x1000, 208); bytes.writeUInt32LE(0x1040, 524);
    bytes.write('VCRUNTIME140.dll\0', 576);
    writeFileSync(path, bytes);
    assert.deepEqual(peImports(path), ['vcruntime140.dll']);
    assert.throws(() => assertStaticWindowsRuntime(path), /external MSVC runtime/);
    bytes.fill(0, 576); bytes.write('KERNEL32.dll\0', 576);
    writeFileSync(path, bytes);
    assert.deepEqual(assertStaticWindowsRuntime(path), ['kernel32.dll']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows-packed Linux drivers get tar mode 0755 with a valid checksum and unchanged content', () => {
  const directory = mkdtempSync(join(tmpdir(), 'blockwright-tar-mode-'));
  const path = join(directory, 'client-fixture.tgz');
  try {
    const bytes = Buffer.alloc(2048);
    const header = bytes.subarray(0, 512);
    header.write(linuxDriverEntry);
    header.write('0000644\0', 100); header.write('00000000005\0', 124); header[156] = 48;
    bytes.write('hello', 512);
    writeFileSync(path, gzipSync(bytes));
    normalizeLinuxDriverMode(path);
    verifyLinuxDriverMode(path);
    const normalized = gunzipSync(readFileSync(path));
    assert.equal(normalized.toString('ascii', 100, 108), '0000755\0');
    assert.equal(normalized.toString('ascii', 512, 517), 'hello');
    const expected = parseInt(normalized.toString('ascii', 148, 154), 8);
    normalized.fill(32, 148, 156);
    assert.equal(normalized.subarray(0, 512).reduce((sum, byte) => sum + byte, 0), expected);
    const original = readFileSync(path);
    normalizeLinuxDriverMode(path);
    assert(readFileSync(path).equals(original), 'normalization is idempotent');
    writeFileSync(path, gzipSync(Buffer.alloc(1024)));
    assert.throws(() => normalizeLinuxDriverMode(path), /exactly one regular Linux driver/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
