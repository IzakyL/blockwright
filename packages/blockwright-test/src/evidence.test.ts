import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Run } from "@izakyl/blockwright-client";
import type { BlockwrightInstance, TaskSpec } from "@izakyl/blockwright-client";
import { minecraft } from "@izakyl/blockwright-minecraft";
import type { MinecraftServer } from "@izakyl/blockwright-minecraft";
import { attachFailureEvidence } from "./index.js";

interface Attachment {
  name: string;
  contentType?: string;
  body?: string | Buffer;
  path?: string;
}

function fakeTestInfo(status: string | undefined, expectedStatus: string, dir: string, attachments: Attachment[]) {
  return {
    status,
    expectedStatus,
    errors: [],
    outputPath: () => dir,
    attach: async (name: string, options: Omit<Attachment, "name">) => {
      attachments.push({ name, ...options });
    },
  } as never;
}

/** An instance that died: evidence must come from its trace, without asking the game anything. */
function deadServer(dir: string, asked: TaskSpec[]): MinecraftServer {
  const tracePath = join(dir, "server.ndjson");
  writeFileSync(tracePath, [
    { ts: "t0", category: "process", name: "process.spawn", data: {} },
    { ts: "t1", category: "process", name: "process.died", data: { code: 1, success: false, crashReport: "/c.txt", crashSummary: ["Description: Ticking entity"] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  mkdirSync(join(dir, "server"), { recursive: true });
  return minecraft.server({
    instanceId: "dead-server", role: "server", instanceDir: join(dir, "server"), tracePath,
    ensureModules: async () => ({ loaded: [], skipped: [] }),
    run: (task: TaskSpec) => {
      asked.push(task);
      return new Run((controller) => {
        controller.fail(new Error("gone"));
        return { cancel: async () => {} };
      });
    },
  } as unknown as BlockwrightInstance);
}

test("evidence is taken only for a test that failed, or one that caught an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-test-evidence-"));
  const taken = async (status: string, expected: string, error?: unknown) => {
    const attachments: Attachment[] = [];
    await attachFailureEvidence(fakeTestInfo(status, expected, dir, attachments), { server: deadServer(dir, []) }, { error });
    return attachments.length > 0;
  };
  assert.equal(await taken("passed", "passed"), false);
  assert.equal(await taken("failed", "passed"), true);
  assert.equal(await taken("failed", "failed"), false, "test.fail() that failed is expected");
  assert.equal(await taken("passed", "passed", new Error("caught")), true);
});

test("a failing test gets the shared evidence attached as JSON and text, crash summary included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-test-evidence-"));
  const attachments: Attachment[] = [];
  const asked: TaskSpec[] = [];
  const evidence = await attachFailureEvidence(fakeTestInfo("failed", "passed", dir, attachments), { server: deadServer(dir, asked) });
  assert.equal(asked.length, 0);
  assert.deepEqual(attachments.map((each) => each.name), ["failure-evidence.json", "failure-evidence.txt"]);
  assert.match(String(attachments[1]!.body), /dead-server \(server\): \n {2}process exited on its own \(code=1\)\n {2}crash report: \/c\.txt\n {4}Description: Ticking entity/);
  assert.equal(evidence?.instances[0]?.crash.crashReport, "/c.txt");
  assert.equal(await attachFailureEvidence(fakeTestInfo("passed", "passed", dir, attachments), { server: deadServer(dir, asked) }), undefined);
});
