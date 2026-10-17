import { join } from 'node:path';
import { run, walk } from './release-lib.mjs';

const files = walk(join(process.cwd(), 'dist')).filter(file => file.endsWith('.test.js'));
if (!files.length) throw new Error(`No compiled package tests in ${process.cwd()}`);
run('node', ['--test', '--test-concurrency=4', ...files], { cwd: process.cwd() });
