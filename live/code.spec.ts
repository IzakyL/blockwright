import { expect, test } from "@playwright/test";
import type { BlockwrightInstance, TaskSpec } from "@izakyl/blockwright-client";
import { liveConfig, runId as runIdFrom, withServer } from "./helpers";

/**
 * Task compilation against the game, on a lone server: task source types against Minecraft and against the
 * mods (NeoForge's own classes reach javac by the same module path), and a task compiled once is cached by
 * its source. (Loading, reloading and unloading modules is live/runtime.spec.ts.)
 */

const CONFIG = liveConfig("blockwright-offscreen.toml");

const TICK_COUNT: TaskSpec = {
  source: `public final class Task {
    public static Object run(dev.blockwright.api.Context ctx) throws Exception {
        Object server = ctx.server();
        return server.getClass().getMethod("getTickCount").invoke(server);
    }
}
`,
};

const TYPED_MINECRAFT: TaskSpec = {
  source: `import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Task {
    public static Object run(dev.blockwright.api.Context ctx) {
        MinecraftServer server = ctx.server();
        ServerLevel level = server.overworld();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tick", server.getTickCount());
        out.put("dimension", level.dimension().location().toString());
        out.put("players", level.players().size());
        out.put("gameTime", level.getGameTime());
        out.put("serverType", server.getClass().getName());
        return out;
    }
}
`,
};

const TYPED_MOD: TaskSpec = {
  source: `import net.neoforged.fml.ModList;
import net.neoforged.neoforge.server.ServerLifecycleHooks;
import java.util.LinkedHashMap;
import java.util.Map;

public final class Task {
    public static Object run(dev.blockwright.api.Context ctx) {
        ModList mods = ModList.get();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sameServer", ServerLifecycleHooks.getCurrentServer() == ctx.server());
        out.put("blockwright", mods.isLoaded("blockwright"));
        out.put("modCount", mods.size());
        return out;
    }
}
`,
};

async function cachedTasks(server: BlockwrightInstance): Promise<number> {
  const status = await server.status();
  expect(status.compiler.available, "the game JVM must run on a JDK for tasks to compile").toBe(true);
  return status.compiler.cachedTasks;
}

test("tasks compile against the game and its mods, and a compiled task is cached by its source", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const report: Record<string, unknown> = {};
  const runId = runIdFrom("code");

  try {
    await withServer({ config: CONFIG, instance: `code-s-${runId}`, trace: `test-results/code-s-${runId}.ndjson` }, async (server) => {
      const before = await cachedTasks(server);
      const first = await server.run<number>(TICK_COUNT).result();
      expect(typeof first).toBe("number");
      const afterFirst = await cachedTasks(server);
      expect(afterFirst, "the first run compiled and cached the task").toBe(before + 1);
      await server.run<number>(TICK_COUNT).result();
      expect(await cachedTasks(server), "the same source hits the compile cache").toBe(afterFirst);

      const typed = await server.run<any>(TYPED_MINECRAFT).result();
      report.typedMinecraft = typed;
      expect(typeof typed.tick).toBe("number");
      expect(typed.dimension).toBe("minecraft:overworld");
      expect(typeof typed.gameTime).toBe("number");
      expect(typed.serverType).toMatch(/^net\.minecraft\.server\./);

      const typedMod = await server.run<any>(TYPED_MOD).result();
      report.typedMod = typedMod;
      expect(typedMod.sameServer, "the task's server is the running one").toBe(true);
      expect(typedMod.blockwright).toBe(true);
      expect(typedMod.modCount).toBeGreaterThan(0);
      report.status = await server.status();
    });
  } finally {
    await testInfo.attach("code-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});
