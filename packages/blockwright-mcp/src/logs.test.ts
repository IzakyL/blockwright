import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseLogSince as parseSince } from "@izakyl/blockwright-minecraft/internal";
import { readLogs } from "./logs.js";
import type { LogTarget } from "./logs.js";

const LOG = [
  "[09Sep2026 14:40:46.097] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running",
  "[09Sep2026 14:40:47.100] [main/WARN] [net.neoforged.fml.loading.FMLConfig/CORE]: Configuration file is not correct. Correcting",
  "[09Sep2026 14:40:48.000] [main/ERROR] [mixin/]: Mixin apply failed example.mixins.json:ChunkMapMixin -> net.minecraft.server.level.ChunkMap",
  "[09Sep2026 14:40:48.010] [main/ERROR] [mixin/]: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: Critical injection failure",
  "\tat org.spongepowered.asm.mixin.injection.struct.InjectionInfo.addTarget(InjectionInfo.java:391)",
  "\tat example.Mod.init(Mod.java:42)",
  "[09Sep2026 14:40:49.000] [Worker/ERROR] [net.minecraft.server.packs.resources.ProfiledReloadInstance/]: Failed to load datapack recipe example:shaped_plank",
  "[09Sep2026 14:40:50.000] [Worker/ERROR] [net.minecraft.core.Registry/]: Missing registry entry for example:widget_block",
  "[09Sep2026 14:40:51.000] [main/INFO] [net.minecraft.server.MinecraftServer/]: Done (5.1s)! For help, type \"help\"",
];

const CRASH = [
  "---- Minecraft Crash Report ----",
  "// Oops.",
  "",
  "Time: 2026-09-09 14:41:00",
  "Description: Rendering overlay",
  "",
  "java.lang.NullPointerException: Cannot invoke \"Example.render()\" because \"this.screen\" is null",
  "\tat example.Overlay.render(Overlay.java:88)",
  "\tat net.minecraft.client.gui.Gui.render(Gui.java:120)",
].join("\n");

function fixture(options: { crash?: boolean; trace?: boolean } = {}): LogTarget {
  const dir = mkdtempSync(join(tmpdir(), "blockwright-logs-test-"));
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "logs", "latest.log"), `${LOG.join("\n")}\n`);
  if (options.crash) {
    mkdirSync(join(dir, "crash-reports"), { recursive: true });
    writeFileSync(join(dir, "crash-reports", "crash-2026-09-09_14.41.00-client.txt"), CRASH);
  }
  const target: LogTarget = { role: "client", instanceId: "fixture-client", instanceDir: dir };
  if (options.trace) {
    const tracePath = join(dir, "trace.ndjson");
    writeFileSync(
      tracePath,
      [
        JSON.stringify({
          ts: "2026-09-09T14:40:46.097Z",
          category: "process",
          name: "process.stdout",
          data: { line: LOG[0] },
        }),
        JSON.stringify({
          ts: "2026-09-09T14:40:52.000Z",
          category: "process",
          name: "process.stderr",
          data: { line: "Exception in thread \"main\" java.lang.OutOfMemoryError: Java heap space" },
        }),
        JSON.stringify({ ts: "2026-09-09T14:40:53.000Z", category: "driver", name: "lifecycle.warning", data: {} }),
        JSON.stringify({
          ts: "2026-09-09T14:40:54.000Z",
          category: "process",
          name: "process.died",
          data: { code: 1, success: false },
        }),
        "",
      ].join("\n"),
    );
    target.tracePath = tracePath;
  }
  return target;
}

test("logs read the instance log and keep the header fields", () => {
  const out = readLogs([fixture()], { analyze: false });
  assert.match(out, /logs: fixture-client \(client\)/);
  assert.match(out, /7 of 7 entries/);
  assert.match(out, /INFO \[Launcher\] ModLauncher running/);
});

test("a stack trace stays attached to the line that threw it", () => {
  const out = readLogs([fixture()], { level: "ERROR", analyze: false });
  assert.match(out, /InvalidInjectionException/);
  assert.match(out, /at example\.Mod\.init/);
});

test("level, grep and limit each narrow what comes back, and the cut is announced", () => {
  const target = fixture();
  assert.ok(!readLogs([target], { level: "ERROR", analyze: false }).includes("ModLauncher running"));
  const grepped = readLogs([target], { grep: "datapack", analyze: false });
  assert.match(grepped, /Failed to load datapack/);
  assert.ok(!grepped.includes("Missing registry entry"));
  const capped = readLogs([target], { limit: 2, analyze: false });
  assert.match(capped, /… \d+ older matching entries hidden/);
});

test("since accepts a window as well as a timestamp, and drops what came before", () => {
  const target = fixture();
  assert.ok(readLogs([target], { since: "2026-09-09T00:00:00Z", analyze: false }).includes("ModLauncher running"));
  assert.match(readLogs([target], { since: "5m", analyze: false }), /0 of 0 entries/);
  assert.ok(parseSince("30s")! <= Date.now());
  assert.throws(() => parseSince("yesterday"), /cannot read since/);
});

test("the analysis names the failures a mod developer is actually hunting", () => {
  const out = readLogs([fixture()], { limit: 1 });
  assert.match(out, /mixin failures \(\d+\):/);
  assert.match(out, /ChunkMapMixin/);
  assert.match(out, /registry problems \(\d+\):/);
  assert.match(out, /example:widget_block/);
  assert.match(out, /datapack problems \(\d+\):/);
  assert.match(out, /exceptions \(\d+ distinct\):/);
  assert.match(out, /InvalidInjectionException/);
});

test("the analysis survives a filter that hid the lines it reports on", () => {
  const out = readLogs([fixture()], { level: "FATAL" });
  assert.match(out, /0 of 7 entries/);
  assert.match(out, /mixin failures/);
});

test("stdout and stderr from the trace fill in what never reached the game log", () => {
  const out = readLogs([fixture({ trace: true })], { analyze: false });
  assert.match(out, /OutOfMemoryError: Java heap space/);
  assert.match(out, /process\.died/);
  assert.equal(out.match(/ModLauncher running/g)?.length, 1, "a line in both sources must not be listed twice");
});

test("source=game ignores the trace, source=trace ignores the game log", () => {
  const target = fixture({ trace: true });
  assert.ok(!readLogs([target], { source: "game", analyze: false }).includes("OutOfMemoryError"));
  const traceOnly = readLogs([target], { source: "trace", analyze: false });
  assert.ok(!traceOnly.includes("Missing registry entry"));
  assert.match(traceOnly, /OutOfMemoryError/);
});

test("a crash is summarised by the driver, and logs show that summary rather than reading the report", () => {
  const target = fixture({ crash: true, trace: true });
  writeFileSync(target.tracePath!, JSON.stringify({
    ts: "2026-09-09T14:41:01.000Z",
    category: "process",
    name: "process.died",
    data: {
      code: 1, success: false, crashReport: "/i/crash-reports/crash-2026-09-09_14.41.00-client.txt",
      crashSummary: ["Description: Rendering overlay", "java.lang.NullPointerException: boom", "\tat example.Overlay.render(Overlay.java:88)"],
    },
  }) + "\n", { flag: "a" });
  const out = readLogs([target], { limit: 1 });
  assert.match(out, /process:\n\s+process exited on its own \(code=1\)\n\s+crash report: \/i\/crash-reports\/crash-2026-09-09_14\.41\.00-client\.txt/);
  assert.match(out, /Description: Rendering overlay/);
  assert.ok(!out.includes("---- Minecraft Crash Report ----"));
});

test("logs say what to do when the session holds nothing", () => {
  assert.match(readLogs([]), /no instance to read logs from/);
  assert.match(
    readLogs([{ role: "server", instanceId: "gone", instanceDir: join(tmpdir(), "blockwright-missing") }]),
    /no readable log at/,
  );
});
