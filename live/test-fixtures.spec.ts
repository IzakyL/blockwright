import { test as plain, expect } from "@playwright/test";
import { createGameTest } from "@izakyl/blockwright-test";
import { evidence, MinecraftCommandError, tick, world } from "@izakyl/blockwright-minecraft";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @izakyl/blockwright-test: createGameTest's fixtures (prefab handles, the launched game, the UI host,
 * evidence targets), one launch path with a graceful server stop, and the shared failure evidence attached to a
 * failing test (checked by the test after it, since a failing test cannot check its own teardown).
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");

plain.describe.configure({ mode: "serial" });

interface Seen {
  title: string;
  status?: string;
  attachments: Array<{ name: string; path?: string; body?: Buffer | string }>;
}

const seen: Seen[] = [];

const test = createGameTest({ cwd: LIVE_DIR, config: OFFSCREEN, instancePrefix: "fixtures" }).extend<{ recordAttachments: void }>({
  // Set up before the game and torn down after it, so it sees what the game's teardown attached.
  recordAttachments: [async ({}, use, testInfo) => {
    await use();
    seen.push({ title: testInfo.title, status: testInfo.status, attachments: testInfo.attachments.map((each) => ({ ...each })) });
  }, { auto: true }],
});

const CHEST = { x: 2, y: -60, z: 2 };

test("the fixtures hand out prefab handles on a launched game", async ({ server, client, game, ui }) => {
  expect(server.instanceId).toBe(game.instances.server.instanceId);
  expect(client.role).toBe("client");
  expect((await tick.status(server)).frozen).toBe(true);
  await world.command(server, `setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} minecraft:chest`);
  expect((await world.block(server, CHEST)).id).toBe("minecraft:chest");
  const observation = await evidence.observe(client, { server, ui });
  expect(observation.player?.dimension).toBe("minecraft:overworld");
  expect(evidence.formatObservation(observation)).toMatch(/server: frozen 20tps/);
});

test("a failing step gets the shared failure evidence attached", async ({ server, failureEvidence }) => {
  test.fail(true, "the step below fails on purpose; the next test checks what was attached");
  await world.command(server, `setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} minecraft:chest`);
  await world.command(server, `item replace block ${CHEST.x} ${CHEST.y} ${CHEST.z} container.0 with minecraft:diamond 7`);
  failureEvidence.containers.push(CHEST);
  failureEvidence.entityTypes.push("minecraft:player");
  const error = await world.command(server, "setblock 0 -60 0 minecraft:no_such_block").catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MinecraftCommandError);
  throw error;
});

plain("the failing test's attachments hold the evidence: observation, containers, screenshots, logs", async () => {
  const passed = seen.find((each) => each.title.startsWith("the fixtures hand out"));
  expect(passed?.status).toBe("passed");
  expect(passed?.attachments.map((each) => each.name)).not.toContain("failure-evidence.json");

  const failed = seen.find((each) => each.title.startsWith("a failing step"));
  expect(failed?.status).toBe("failed");
  const names = failed!.attachments.map((each) => each.name);
  expect(names).toEqual(expect.arrayContaining(["failure-evidence.json", "failure-evidence.txt", "evidence-view.png"]));

  const json = failed!.attachments.find((each) => each.name === "failure-evidence.json")!;
  const taken = JSON.parse(String(json.body)) as evidence.FailureEvidence;
  expect(taken.instances.map((each) => each.role)).toEqual(["server", "client"]);
  expect(taken.instances.every((each) => each.crash.ended === undefined)).toBe(true);
  expect(taken.tick?.frozen).toBe(true);
  expect(taken.observation?.server?.playerCount).toBe(1);
  expect(taken.player?.type).toBe("minecraft:player");
  const chest = taken.containers?.find((each) => each.pos.x === CHEST.x && each.pos.z === CHEST.z);
  expect(chest?.slots).toEqual([expect.objectContaining({ slot: 0, id: "minecraft:diamond", count: 7 })]);
  expect(taken.entities?.entities[0]?.type).toBe("minecraft:player");
  expect(taken.screenshots.length).toBe(5);
  for (const shot of failed!.attachments.filter((each) => each.name.endsWith(".png"))) {
    expect(existsSync(shot.path!)).toBe(true);
  }
  const text = String(failed!.attachments.find((each) => each.name === "failure-evidence.txt")!.body);
  expect(text).toMatch(/containers \(\d+\):[\s\S]*minecraft:chest: 0:minecraft:diamond x7/);
  expect(text).toMatch(/screenshots \(5\):/);
  expect(readFileSync(failed!.attachments.find((each) => each.name === "evidence-view.png")!.path!).subarray(1, 4).toString()).toBe("PNG");
});
