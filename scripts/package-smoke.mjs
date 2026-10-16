import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { BlockwrightDriver } from '@izakyl/blockwright-client';
import { CORE, CLIENT, WORLD, MEDIA } from '@izakyl/blockwright-minecraft';
import '@izakyl/blockwright-ui';
import '@izakyl/blockwright-test';
import '@izakyl/blockwright-mcp';
import '@izakyl/blockwright-cinema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const require = createRequire(import.meta.url);
for (const module of [CORE, CLIENT, WORLD, MEDIA]) assert(Object.keys(module.spec().sources).length > 0);
assert.equal(process.arch, 'x64');
assert(['linux', 'win32'].includes(process.platform));
const dist = dirname(require.resolve('@izakyl/blockwright-client'));
const manifest = JSON.parse(readFileSync(join(dist, 'bundle-manifest.json'), 'utf8'));
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.complete, true);
assert.deepEqual(Object.keys(manifest.targets).sort(), ['linux-x64', 'win32-x64']);
const binary = join(dist, manifest.targets[`${process.platform}-${process.arch}`].executable);
assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), `blockwright ${manifest.version}`);
const driver = new BlockwrightDriver();
try { assert.deepEqual(await driver.request('ping'), { pong: true }); } finally { await driver.closeAsync(); }
const main = join(dirname(require.resolve('@izakyl/blockwright-mcp')), 'main.js');
assert.match(execFileSync(process.execPath, [main, '--help'], { encoding: 'utf8', windowsHide: true }), /Usage: blockwright-mcp/);
const transport = new StdioClientTransport({ command: process.execPath, args: [main] });
const client = new Client({ name: 'package-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some(tool => tool.name === 'blockwright_launch'));
} finally { await client.close(); }
console.log('Installed package imports, Java sources, driver ping, CLI and MCP handshake passed.');
