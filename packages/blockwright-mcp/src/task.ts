import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { BlockwrightRunError, readModuleDir } from "@izakyl/blockwright-client";
import type { RunEnd } from "@izakyl/blockwright-client";
import { defineTask, javaTask } from "@izakyl/blockwright-minecraft";
import { unstamp } from "@izakyl/blockwright-minecraft/internal";
import { budgetedJson } from "./budget.js";
import { failure, text } from "./result.js";
import type { ToolResult } from "./result.js";
import { roleArg } from "./schema.js";
import type { Args } from "./schema.js";
import type { BlockwrightSession } from "./session.js";
import type { RecordedModule } from "./spec.js";

export const taskShape = {
  source: z.string().optional().describe(
    "a whole task: public final class Task { public static Object run(dev.blockwright.api.Context ctx) throws Exception { ... } }"),
  body: z.string().optional().describe(
    "only the body of run(ctx); dev.blockwright.api.*, blockwright.minecraft.core.*, java.util.* and java.util.concurrent.* are imported"),
  imports: z.array(z.string()).optional().describe("with body: more imports (class names or pkg.*)"),
  file: z.string().optional().describe("a .java file holding a whole task, relative to the working directory"),
  role: roleArg,
  thread: z.enum(["server", "client", "worker"]).optional(),
  args: z.record(z.unknown()).optional(),
  modules: z.array(z.object({
    root: z.string().describe("the source root the package directories are under"),
    package: z.string(),
    recursive: z.boolean().optional(),
  })).optional().describe("library modules to load (or reload, when changed) before the task runs, in order"),
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  limit: z.number().int().min(1).max(200).optional().describe("JSON outputs listed (default 20; the last is always shown)"),
};

export type TaskRequest = Args<typeof taskShape>;

function end(error: unknown): RunEnd | undefined {
  return error instanceof BlockwrightRunError ? error.end : undefined;
}

/**
 * A thin wrapper over `instance.run`: a Java task (whole, from a file, or a body with the prefab's imports)
 * runs in the game on the prefab handle (core modules loaded, the client settled), its output stream is
 * collected — JSON outputs, binary outputs saved as files — and the run's end is reported as it is.
 */
export async function runTask(session: BlockwrightSession, request: TaskRequest): Promise<ToolResult> {
  const role = request.role ?? "server";
  const given = [request.source, request.body, request.file].filter((each) => each !== undefined).length;
  if (given !== 1) return failure("pass exactly one of source, body or file");
  const source = request.source
    ?? (request.body !== undefined
      ? javaTask({ body: request.body, ...(request.imports ? { imports: request.imports } : {}) })
      : readFileSync(resolve(session.cwd, request.file!), "utf8"));
  const handle = session.handle(role);

  const modules: RecordedModule[] = (request.modules ?? []).map((module) => ({
    root: resolve(session.cwd, module.root),
    package: module.package,
    ...(module.recursive ? { recursive: true } : {}),
  }));
  let loaded = "";
  if (modules.length > 0) {
    const specs = modules.map((module) => readModuleDir(module.root, module.package, { recursive: module.recursive === true }));
    await handle.ensure();
    const result = await handle.instance.ensureModules(specs);
    loaded = `modules: ${result.loaded.length > 0 ? `loaded ${result.loaded.join(", ")}` : "none changed"}\n`;
  }

  const template = defineTask<Record<string, unknown>, unknown>({
    name: "task",
    side: role,
    ...(request.thread ? { thread: request.thread } : {}),
    requiresOutput: false,
    source,
  });
  const started = Date.now();
  const json: unknown[] = [];
  const binaries: string[] = [];
  let runEnd: RunEnd = { status: "ok" };
  let thrown: unknown;
  try {
    const run = await handle.start(template, request.args ?? {}, request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {});
    for await (const output of run) {
      if (output.kind === "json") {
        const { value, mark } = unstamp(output.value);
        if (mark) handle.sync.record(mark);
        json.push(value);
      } else {
        const path = session.artifactPath(`task-${started}-${binaries.length + 1}`, "bin");
        writeFileSync(path, output.data);
        binaries.push(`${path} (${output.data.length} bytes${output.meta == null ? "" : `, meta ${JSON.stringify(output.meta).slice(0, 200)}`})`);
      }
    }
  } catch (error) {
    const ended = end(error);
    if (ended) runEnd = ended;
    else thrown = error;
  }
  const elapsed = Date.now() - started;
  session.record({
    kind: "task", role, source,
    ...(request.args ? { args: request.args } : {}),
    ...(request.thread ? { thread: request.thread } : {}),
    ...(modules.length > 0 ? { modules } : {}),
    succeeded: thrown === undefined && runEnd.status === "ok",
  });
  if (thrown !== undefined) throw thrown;

  const limit = request.limit ?? 20;
  const lines = [`${loaded}task on the ${role}: ${runEnd.status} after ${elapsed}ms, ${json.length} JSON output(s)${binaries.length ? `, ${binaries.length} binary` : ""}`];
  if (json.length > 1) {
    const listed = json.slice(0, -1).slice(-limit + 1);
    if (json.length - 1 > listed.length) lines.push(`… ${json.length - 1 - listed.length} earlier outputs not shown`);
    for (const value of listed) lines.push(`- ${budgetedJson(value, { maxItems: 10, maxDepth: 4 }).split("\n").join("\n  ")}`);
  }
  for (const binary of binaries) lines.push(`binary: ${binary}`);
  if (json.length > 0) lines.push(`last:\n${budgetedJson(json[json.length - 1], { maxItems: 40, maxDepth: 8 })}`);
  if (runEnd.status === "error") {
    lines.push(`error ${runEnd.error.code}: ${runEnd.error.message}`);
    if (runEnd.error.detail !== undefined) lines.push(budgetedJson(runEnd.error.detail, { maxItems: 20, maxDepth: 5, maxString: 2000 }));
    return failure(lines.join("\n"));
  }
  if (runEnd.status === "cancelled") return failure(lines.join("\n"));
  return text(lines.join("\n"));
}
