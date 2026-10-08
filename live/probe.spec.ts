import { expect, test } from "@playwright/test";
import { world } from "@izakyl/blockwright-minecraft";
import { liveConfig, runId as runIdFrom, withServer } from "./helpers";

/**
 * Region reads cell by cell, on a lone server: the cell order (x fastest, then z, then y from min), states in the
 * palette, corners given in any order, cells in unloaded chunks reported as such rather than generated, and the
 * volume ceiling. (Counts, probes and in-game waits are live/minecraft-world.spec.ts.)
 */

const CONFIG = liveConfig("blockwright-offscreen.toml");

test("regions read cell by cell, name unloaded cells, and refuse a volume past the ceiling", async () => {
  test.setTimeout(600_000);
  const runId = runIdFrom("probe");

  await withServer({ config: CONFIG, instance: `probe-s-${runId}`, trace: `test-results/probe-s-${runId}.ndjson` }, async (_, server) => {
    await world.command(server, [
      "forceload add 10 10 14 14",
      "fill 10 -60 10 14 -56 14 minecraft:air",
      "fill 10 -60 10 14 -60 14 minecraft:stone",
      "setblock 12 -59 12 minecraft:chest",
      "setblock 10 -59 10 minecraft:lever[face=floor,facing=north,powered=true]",
    ], { allowFailure: true });

    // Corners in either order.
    const region = await world.region(server, { x: 14, y: -59, z: 14 }, { x: 10, y: -60, z: 10 }, { cells: true });
    expect(region.size).toEqual({ x: 5, y: 2, z: 5 });
    expect(region.min).toEqual({ x: 10, y: -60, z: 10 });
    expect(region.volume).toBe(50);
    expect(region.counts["minecraft:stone"]).toBe(25);
    expect(region.counts["minecraft:chest"]).toBe(1);
    expect(region.counts["minecraft:lever"]).toBe(1);
    expect(region.counts["minecraft:air"]).toBe(23);
    expect(region.cells).toHaveLength(50);
    const at = (x: number, y: number, z: number) => region.palette[region.cells![(y + 60) * 25 + (z - 10) * 5 + (x - 10)]!];
    expect(at(12, -59, 12), "cells are indexed y, then z, then x from min").toBe("minecraft:chest");
    expect(at(10, -59, 10)).toBe("minecraft:lever");
    expect(at(14, -60, 10)).toBe("minecraft:stone");
    expect(at(14, -59, 10)).toBe("minecraft:air");

    const states = await world.region(server, { x: 10, y: -59, z: 10 }, { x: 10, y: -59, z: 10 }, { states: true });
    expect(states.palette[0]).toMatch(/^minecraft:lever\[.*powered=true/);

    const far = await world.region(server, { x: 900_000, y: 0, z: 900_000 }, { x: 900_001, y: 0, z: 900_000 });
    expect(far.counts, "a region outside loaded chunks says so instead of generating them").toEqual({ "blockwright:unloaded": 2 });

    await expect(world.region(server, { x: 0, y: -64, z: 0 }, { x: 99, y: 0, z: 99 })).rejects.toThrow(/volume/);
  });
});
