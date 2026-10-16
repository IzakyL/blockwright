import { gradle } from './release-lib.mjs';
gradle('coverage-report', ['--no-daemon', 'test']);
gradle('neoforge-agent', ['--no-daemon', 'check']);
