import { createGameTest, expect } from "@izakyl/blockwright-test";
import { isMinecraftError, reflect } from "@izakyl/blockwright-minecraft";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * Reflective calls answered by each side on its own: a client (which runs no server) invokes statics, drills
 * static paths, keeps and passes handles and reads its own level; handles stay with the side that made them.
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright-offscreen.toml") });

const RENDER_SYSTEM = "com.mojang.blaze3d.systems.RenderSystem";
const UTIL = "net.minecraft.Util";
const BLOCKS = "net.minecraft.world.level.block.Blocks";
const BLOCK = "net.minecraft.world.level.block.Block";
const BLOCK_STATE = "net.minecraft.world.level.block.state.BlockState";
const OBJECTS = "java.util.Objects";
const STONE_DESCRIPTION_ID = "block.minecraft.stone";

test("a static invoke is answered by a client that has no server", async ({ server, client }, testInfo) => {
  const report: Record<string, unknown> = {};

  try {
    const onThread = await reflect.invoke(client, {
      target: { kind: "static", className: RENDER_SYSTEM },
      method: "isOnRenderThread",
      returnType: "boolean",
    });
    report.client_static = onThread;
    expect(onThread.found).toBe(true);
    expect(onThread.ownerType).toBe(RENDER_SYSTEM);
    expect(onThread.signature).toContain("isOnRenderThread");
    expect(reflect.boolean(onThread), "it ran on the client's render thread").toBe(true);

    const drilled = await reflect.invoke(client, { target: { kind: "static", className: BLOCKS, path: "STONE" }, method: "getDescriptionId" });
    report.client_static_path = drilled;
    expect(drilled.ownerType, "the receiver is what the path drilled out").toBe(BLOCK);
    expect(reflect.string(drilled)).toBe(STONE_DESCRIPTION_ID);

    const drilledDeep = await reflect.invoke(client, {
      target: { kind: "static", className: BLOCKS, path: "STONE.defaultBlockState()" },
      method: "getBlock",
      returnHandle: true,
    });
    report.client_static_path_handle = drilledDeep;
    expect(drilledDeep.ownerType, "the second segment is a no-arg call on the first").toBe(BLOCK_STATE);
    expect(drilledDeep.handleType).toBe(BLOCK);
    expect(typeof drilledDeep.handle, "returnHandle kept the drilled-out object").toBe("string");

    const handleAsArg = await reflect.invoke(client, {
      target: { kind: "static", className: OBJECTS },
      method: "toString",
      args: [{ $handle: drilledDeep.handle }],
      argTypes: ["java.lang.Object"],
    });
    report.client_handle_as_arg = handleAsArg;
    expect(reflect.string(handleAsArg), "the argument was the stone Block itself").toContain("minecraft:stone");

    const handleAsTarget = await reflect.invoke(client, { target: { kind: "handle", handle: drilledDeep.handle! }, method: "getDescriptionId" });
    report.client_handle_target = handleAsTarget;
    expect(handleAsTarget.ownerType).toBe(BLOCK);
    expect(reflect.string(handleAsTarget)).toBe(STONE_DESCRIPTION_ID);

    // A client's level root is its own level.
    const level = await reflect.invoke(client, { target: { kind: "level" }, method: "dimension", limits: { maxDepth: 2 } });
    report.client_level_target = level;
    expect(level.found).toBe(true);
    expect(level.ownerType).toMatch(/ClientLevel$/);
    expect(JSON.stringify(level.returned)).toContain("overworld");

    // Handles belong to the side that made them.
    const foreign = await reflect.invoke(server, { target: { kind: "handle", handle: drilledDeep.handle! }, method: "getDescriptionId" })
      .catch((error: unknown) => error);
    report.server_foreign_handle = String(foreign);
    expect(isMinecraftError(foreign, "not-found"), `the server does not know the client's handle: ${String(foreign)}`).toBe(true);
    expect(await reflect.release(client, drilledDeep.handle!)).toEqual({ released: 1 });

    const onServer = await reflect.invoke(server, { target: { kind: "static", className: UTIL }, method: "getMillis", returnType: "long" });
    report.server_static = onServer;
    expect(onServer.ownerType).toBe(UTIL);
    expect(reflect.number(onServer)).toBeGreaterThan(0);

    const drilledOnServer = await reflect.invoke(server, { target: { kind: "static", className: BLOCKS, path: "STONE" }, method: "getDescriptionId" });
    report.server_static_path = drilledOnServer;
    expect(drilledOnServer.ownerType).toBe(BLOCK);
    expect(reflect.string(drilledOnServer)).toBe(STONE_DESCRIPTION_ID);
  } finally {
    await testInfo.attach("static-invoke-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});
