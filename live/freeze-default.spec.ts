import { expect, test } from "@playwright/test";
import { tick, world } from "@izakyl/blockwright-minecraft";
import type { MinecraftServer } from "@izakyl/blockwright-minecraft";
import { liveConfig, runId as runIdFrom, withServer } from "./helpers";

/**
 * A runtime launch option, on lone servers: a server starts with its ticks frozen before its first tick
 * (the default), so an idle world does not advance and only a sprint moves it; `startFrozen: false` opts out.
 */

const CONFIG = liveConfig("blockwright-offscreen.toml");
const IDLE_MS = 3_000;

async function idleDelta(server: MinecraftServer): Promise<number> {
  const t0 = (await world.time(server)).gameTime;
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
  return (await world.time(server)).gameTime - t0;
}

test("freeze-by-default freezes the simulation, and opting out runs free", async () => {
  test.setTimeout(600_000);
  const runId = runIdFrom("freezeab");

  const A = await withServer({ config: CONFIG, instance: `freezeA-${runId}`, trace: `test-results/freezeA-${runId}.ndjson` }, async (_, a) => {
    const frozenAtReady = (await tick.status(a)).frozen;
    const idle = await idleDelta(a);
    const sprint = await tick.sprint(a, 20);
    return {
      frozenAtReady,
      idleDelta: idle,
      sprintDelta: sprint.gameTime - sprint.startGameTime,
      frozenAfterSprint: (await tick.status(a)).frozen,
    };
  });
  const B = await withServer(
    { config: CONFIG, instance: `freezeB-${runId}`, trace: `test-results/freezeB-${runId}.ndjson`, startFrozen: false },
    async (_, b) => ({
      frozenAtReady: (await tick.status(b)).frozen,
      idleDelta: await idleDelta(b),
    }),
  );

  console.log("[freeze-ab] " + JSON.stringify({ A, B }));

  expect(A.frozenAtReady, "a server launched with the defaults is frozen once ready").toBe(true);
  expect(Math.abs(A.idleDelta), `an idle frozen world stays put for ${IDLE_MS}ms; it moved ${A.idleDelta}`).toBeLessThanOrEqual(3);
  expect(A.sprintDelta, "a 20-tick sprint advances the frozen world by 20").toBeGreaterThanOrEqual(18);
  expect(A.frozenAfterSprint, "and leaves it frozen").toBe(true);

  expect(B.frozenAtReady, "startFrozen: false launches a running server").toBe(false);
  expect(B.idleDelta, `a running world advances on its own in ${IDLE_MS}ms; it moved ${B.idleDelta}`).toBeGreaterThan(20);
});
