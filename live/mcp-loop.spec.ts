import { expect, test } from "@playwright/test";
import { BlockwrightSession } from "@izakyl/blockwright-mcp";
import { callTool as call } from "./helpers";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The MCP loop: launch through launchGame, commands, a Java task through blockwright_task,
 * a batch with an in-game wait, screenshots from a camera preset, a recording with a camera path, the shared
 * observation and failure evidence, logs, and a spec exported against @izakyl/blockwright-test + @izakyl/blockwright-minecraft.
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");
const OUT = path.join(LIVE_DIR, "test-results/mcp-loop");
const EXPORTED = path.join(OUT, "exported.spec.ts");
const VIDEO = path.join(OUT, "orbit.mp4");

test("the MCP loop: launch, act, run code in the game, batch with a server-side wait, see, record, export", async () => {
  test.setTimeout(900_000);
  rmSync(OUT, { recursive: true, force: true });
  const session = new BlockwrightSession({ cwd: LIVE_DIR, config: OFFSCREEN, instancePrefix: "mcp-loop", artifactDir: OUT });
  try {
    const launched = await call(session, "blockwright_launch");
    expect(launched).toMatch(/ui adapters: minecraft$/m);
    await expect(call(session, "blockwright_launch")).rejects.toThrow(/already holds/);

    await call(session, "blockwright_command", { commands: ["fill 30 -60 30 34 -56 34 minecraft:air", "forceload add 30 30"] });
    const built = await call(session, "blockwright_command", { command: "fill 30 -60 30 34 -60 34 minecraft:stone" });
    expect(built).toMatch(/-> ok\nSuccessfully filled 25 block/);

    // A whole task, with an intermediate output and a stamped answer.
    const counted = await call(session, "blockwright_task", {
      source: `import dev.blockwright.api.*;
public final class Task {
    public static Object run(Context ctx) throws Exception {
        var level = ctx.server().overworld();
        int stone = 0;
        for (int x = 30; x <= 34; x++) for (int z = 30; z <= 34; z++)
            if (level.getBlockState(new net.minecraft.core.BlockPos(x, -60, z)).is(net.minecraft.world.level.block.Blocks.STONE)) stone++;
        ctx.emit(java.util.Map.of("scanned", 25));
        return java.util.Map.of("stone", stone, "want", ((Number) ctx.arg("want")).intValue());
    }
}`,
      args: { want: 25 },
    });
    expect(counted).toMatch(/task on the server: ok after \d+ms, 2 JSON output\(s\)/);
    expect(counted).toMatch(/"scanned": 25/);
    expect(counted).toMatch(/last:\n[\s\S]*"stone": 25/);

    // Only a body, with the prefab's helpers imported; and a compile error reported as the run's end.
    expect(await call(session, "blockwright_task", { body: `return GameJson.pos(new net.minecraft.core.BlockPos(1, 2, 3));` }))
      .toMatch(/"x": 1,\s+"y": 2,\s+"z": 3/);
    await expect(call(session, "blockwright_task", { body: "return nope;" })).rejects.toThrow(/error compile: .*cannot find symbol/s);

    const batch = await call(session, "blockwright_batch", {
      steps: [
        { tool: "command", args: { command: "setblock 32 -59 32 minecraft:chest" } },
        { tool: "command", args: { command: "item replace block 32 -59 32 container.0 with minecraft:diamond 3" } },
        { tool: "command", args: { command: "setblock 32 -50 33 minecraft:sand" } },
        { tool: "tick", args: { until: "execute if block 32 -59 33 minecraft:sand", maxTicks: 200 } },
      ],
    });
    expect(batch).toMatch(/batch: 4 of 4 steps ran, 0 failed/);
    expect(batch).toMatch(/predicate passed after \d+ ticks/);

    expect(await call(session, "blockwright_query", { domain: "container", position: { x: 32, y: -59, z: 32 } }))
      .toMatch(/"id": "minecraft:diamond",\s+"count": 3/);

    const shots = await call(session, "blockwright_screenshot", {
      bounds: { min: { x: 30, y: -60, z: 30 }, max: { x: 34, y: -58, z: 34 } },
      preset: "elevations",
      label: "lot",
      inline: false,
    });
    expect(shots).toMatch(/1\. south .*4\. east/s);

    const recording = await call(session, "blockwright_record", {
      op: "video.start",
      path: VIDEO,
      cameraPath: { bounds: { min: { x: 30, y: -60, z: 30 }, max: { x: 34, y: -58, z: 34 } }, presetCount: 8, seconds: 3 },
    });
    expect(recording).toMatch(/camera moving through 8 viewpoints over 3s/);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    expect(await call(session, "blockwright_record", { op: "video.stop" })).toMatch(/camera back on the player/);
    expect(statSync(VIDEO).size).toBeGreaterThan(10_000);

    expect(await call(session, "blockwright_observe", { mode: "full" }))
      .toMatch(/instance: \S+\nscreen: none[\s\S]*server: frozen 20tps tick \d+ gameTime \d+ players 1/);

    // The failure evidence a test would attach, from the live session (it does not freeze or change it).
    const evidence = await call(session, "blockwright_observe", { mode: "evidence" });
    expect(evidence).toMatch(/\(server\): running/);
    expect(evidence).toMatch(/player \(server\): \S+ at /);
    expect(evidence).toMatch(/screenshots \(5\):\n\s+view: .*\.png/);

    expect(await call(session, "blockwright_logs", { role: "server", level: "INFO", grep: "Done \\(" })).toMatch(/Done \(/);

    const listed = await call(session, "blockwright_export", { op: "list" });
    expect(listed).toMatch(/task on the server/);
    const exported = await call(session, "blockwright_export", { op: "spec", name: "mcp loop replay", path: EXPORTED });
    expect(exported).toMatch(/wrote .*exported\.spec\.ts/);
    const spec = readFileSync(EXPORTED, "utf8");
    expect(spec).toContain('await server.run(defineTask<Record<string, unknown>, unknown>({ name: "task 1", side: "server"');
    expect(spec).toContain('await world.waitFor(server, "execute if block 32 -59 33 minecraft:sand", { maxTicks: 200 });');
    expect(spec).toContain('await world.command(server, "fill 30 -60 30 34 -60 34 minecraft:stone");');
    expect(spec).toMatch(/await media\.screenshot\(client, \{ path: test\.info\(\)\.outputPath\("01-lot-south\.png"\), camera: /);
  } finally {
    await session.close();
  }
  expect(existsSync(EXPORTED)).toBe(true);
});
