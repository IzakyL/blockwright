import { strict as assert } from "node:assert";
import test from "node:test";

import { InstanceDeathDiagnostics } from "./instance-helpers.js";
import type { TraceEvent } from "./types-core.js";

test("a crash names the exception the agent reported under its payload", () => {
  const diagnostics = new InstanceDeathDiagnostics();
  diagnostics.observe({
    name: "blockwright.crash",
    data: {
      thread: "Render thread",
      role: "client",
      data: { thread: "Render thread", exceptionClass: "net.neoforged.fml.ModLoadingException", message: "mod loading failed" },
    },
  } as unknown as TraceEvent);
  assert.deepEqual(diagnostics.summarize(), [
    "crash [Render thread] net.neoforged.fml.ModLoadingException: mod loading failed",
  ]);
});
