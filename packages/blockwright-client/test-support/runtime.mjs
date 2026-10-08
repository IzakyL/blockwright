import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const driverMethods = new Set(['ping', 'neoforge.launch', 'lifecycle.close', 'game.connect']);

/**
 * A whole mock driver in `dir`, speaking the driver's stdio JSON-RPC: every request is logged to
 * requests.jsonl, a launch writes the role's `traceLines` to a fresh trace file, `game.connect` answers
 * `game` (the descriptor of a fake agent the test runs), and `handle(method, params)` may answer
 * anything first (a promise delays the reply; undefined falls back to the built-in answer). Instance
 * ids default to <role>-<n>.
 */
export async function serveMockDriver({ dir, traceLines, game, handle = () => undefined }) {
  let launched = 0;
  const builtIn = {
    'neoforge.launch': params => {
      const role = params.role ?? 'server';
      const instanceId = params.instance ?? `${role}-${++launched}`;
      const tracePath = join(dir, `${instanceId}.trace.jsonl`);
      const lines = Array.isArray(traceLines) ? traceLines : traceLines[role] ?? [];
      writeFileSync(tracePath, lines.map(line => JSON.stringify(line) + '\n').join(''));
      return { instanceId, role, tracePath, instanceDir: dir };
    },
    'lifecycle.close': () => ({ success: true, code: 0 }),
    'game.connect': () => game,
    'ping': () => ({ pong: true }),
  };
  const input = createInterface({ input: process.stdin });
  input.on('line', async line => {
    const request = JSON.parse(line);
    const params = request.params ?? {};
    appendFileSync(join(dir, 'requests.jsonl'), JSON.stringify({ method: request.method, params }) + '\n');
    if (!driverMethods.has(request.method)) throw new Error(`not a driver method reached the driver: ${request.method}`);
    const result = await handle(request.method, params) ?? builtIn[request.method]?.(params);
    process.stdout.write(JSON.stringify(result === undefined
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unknown method: ${request.method}` } }
      : { jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
}
