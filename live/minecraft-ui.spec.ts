import { expect, test } from "@playwright/test";
import {
  defineTask,
  input,
  javaTask,
  launchGame,
  player,
  reflect,
  screen,
  ui,
  type BlockPos,
  type Game,
  type PlayerJson,
} from "@izakyl/blockwright-minecraft";
import { formatView, UiWaitTimeoutError, type UiAction, type UiCodegen, type UiHost, type UiNode, type UiView } from "@izakyl/blockwright-ui";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { MinecraftClient } from "@izakyl/blockwright-minecraft";

/**
 * @izakyl/blockwright-ui on the Minecraft platform in a real game: the vanilla adapter reads the inventory, a
 * crafting table opened through the player, the pause and options screens and chat, each read in one task;
 * the host acts on refs, selectors and points, waits in the game, and its codegen compiles against the API.
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSCREEN = path.join(LIVE_DIR, "blockwright-offscreen.toml");
const GLFW_KEY_ESCAPE = 256;

test.describe.configure({ mode: "serial" });

const SERVER_PLAYER = defineTask<void, PlayerJson>({
  name: "test.serverPlayer",
  side: "server",
  source: javaTask({ body: `return GameJson.player(Levels.player(ctx, null));` }),
});

const SETUP = defineTask<{ items?: Array<{ slot: number; id: string; count: number }> }, boolean>({
  name: "test.setup",
  side: "server",
  source: javaTask({
    imports: [
      "net.minecraft.server.level.ServerPlayer", "net.minecraft.world.level.GameType", "net.minecraft.world.item.ItemStack",
      "net.minecraft.core.registries.BuiltInRegistries", "net.minecraft.resources.ResourceLocation",
    ],
    body: `Args args = Args.of(ctx);
var player = (ServerPlayer) Levels.player(ctx, null);
player.setGameMode(GameType.SURVIVAL);
player.getInventory().clearContent();
var items = args.list("items");
for (int i = 0; items != null && i < items.size(); i++) {
    Args item = Args.of(items.get(i), "items[" + i + "]");
    var stack = new ItemStack(BuiltInRegistries.ITEM.get(ResourceLocation.parse(item.string("id"))), (int) item.integer("count"));
    player.getInventory().setItem((int) item.integer("slot"), stack);
}
player.inventoryMenu.broadcastChanges();
return Sync.stamp(true);`,
  }),
});

const SET_BLOCK = defineTask<{ pos: BlockPos; state: string }, boolean>({
  name: "test.setBlock",
  side: "server",
  source: javaTask({
    imports: ["net.minecraft.commands.arguments.blocks.BlockStateParser", "net.minecraft.core.registries.BuiltInRegistries"],
    body: `Args args = Args.of(ctx);
var state = BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK.asLookup(), args.string("state"), false).blockState();
ctx.server().overworld().setBlock(args.blockPos("pos"), state, 3);
return Sync.stamp(true);`,
  }),
});

/** What the cursor carries in the open container screen, read reflectively (e.g. `5 minecraft:diamond`). */
async function carried(client: MinecraftClient): Promise<string> {
  const read = await reflect.query(client, {
    root: { kind: "static", className: "net.minecraft.client.Minecraft", path: "getInstance().player.containerMenu" },
    select: { carried: "getCarried().toString()" },
  });
  return String(read.tree?.values?.carried);
}

function nodes(view: UiView): UiNode[] {
  const out: UiNode[] = [];
  const visit = (node: UiNode) => {
    out.push(node);
    node.children.forEach(visit);
  };
  view.layers.forEach((layer) => layer.roots.forEach(visit));
  return out;
}

function refOf(view: UiView, predicate: (node: UiNode) => boolean): string {
  const node = nodes(view).find(predicate);
  expect(node, "no such node on screen").toBeDefined();
  const ref = view.refOf.get(node!);
  expect(ref, `${node!.key} has no ref`).toBeDefined();
  return ref!;
}

function slotItem(view: UiView, index: number): { id: string; count?: number } | undefined {
  return nodes(view).find((node) => node.key === `slot:${index}`)?.item;
}

test.describe("@izakyl/blockwright-ui with the vanilla adapter on an offscreen game", () => {
  let mc: Game;
  let host: UiHost<MinecraftClient, ui.Probe>;
  /** Every statement codegen produced, compiled together at the end. */
  const recorded: UiCodegen[] = [];

  const act = async (target: Parameters<typeof host.act>[1], action: UiAction) => {
    const result = await host.act(mc.client, target, action, { timeoutMs: 5_000 });
    const code = host.codegen(result.entry, action, result.point);
    expect(code, `no code for ${result.summary}`).toBeDefined();
    recorded.push(code!);
    return { ...result, code: code! };
  };

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    mc = await launchGame({
      cwd: LIVE_DIR,
      config: OFFSCREEN,
      server: { trace: "test-results/mc-ui-server.ndjson", instance: "mc-ui-s" },
      client: { trace: "test-results/mc-ui-client.ndjson", instance: "mc-ui-c" },
    });
    host = ui.host();
    expect(await host.verify(mc.client)).toEqual([]);
  });

  test.afterAll(async () => {
    test.setTimeout(180_000);
    await mc?.close();
  });

  test.afterEach(async () => {
    if (mc) await screen.dismiss(mc.client).catch(() => undefined);
  });

  test("no screen reads as no layer, in one task", async () => {
    const view = await host.read(mc.client);
    expect(view.layers).toEqual([]);
    expect(view.errors).toEqual([]);
    expect(formatView(view)).toBe("nothing addressable on screen");
  });

  test("inventory: slots by menu index, clicked by ref and by selector; waits for a slot", async () => {
    await mc.server.run(SETUP, { items: [{ slot: 0, id: "minecraft:diamond", count: 5 }] });
    await input.key(mc.client, { keybind: "key.inventory" });
    await screen.waitFor(mc.client, "InventoryScreen");

    const view = await host.read(mc.client);
    expect(view.layers.map((layer) => layer.adapter)).toEqual([ui.ADAPTER_ID]);
    expect(nodes(view).filter((node) => node.role === "slot")).toHaveLength(46);
    expect(slotItem(view, 36)).toEqual({ id: "minecraft:diamond", count: 5 });
    console.log(formatView(view));

    const diamonds = refOf(view, (node) => node.item?.id === "minecraft:diamond");
    expect(host.entry(diamonds)).toMatchObject({ adapter: ui.ADAPTER_ID, selector: { slot: 36 }, fragile: false });
    const picked = await act({ ref: diamonds }, { kind: "click" });
    expect(picked.summary).toBe("clicked slot 36 (minecraft:diamond)");
    expect(picked.code.code).toBe("await screen.clickSlot(client, 36);");
    expect(await carried(mc.client)).toBe("5 minecraft:diamond");

    await act({ adapter: ui.ADAPTER_ID, selector: { slot: 9 } }, { kind: "click", button: "right" });
    await act({ adapter: ui.ADAPTER_ID, selector: { slot: 10 } }, { kind: "click" });
    const after = await host.read(mc.client);
    expect(slotItem(after, 9)).toEqual({ id: "minecraft:diamond", count: 1 });
    expect(slotItem(after, 10)).toEqual({ id: "minecraft:diamond", count: 4 });
    expect(slotItem(after, 36)).toBeUndefined();
    // The same ref still names slot 36, now empty.
    expect(after.refOf.get(nodes(after).find((node) => node.key === "slot:36")!)).toBe(diamonds);

    await host.waitFor(mc.client, { ref: diamonds }, "actionable");
    const missing = await host.waitFor(mc.client, { adapter: ui.ADAPTER_ID, selector: { slot: 99 } }, "actionable", { timeoutMs: 300 })
      .catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(UiWaitTimeoutError);
    expect((missing as UiWaitTimeoutError).detail).toContain("missing");

    await screen.dismiss(mc.client);
    await host.waitFor(mc.client, { ref: diamonds }, "absent", { timeoutMs: 2_000 });
  });

  test("crafting table opened through the player: four planks placed by right clicks craft a table", async () => {
    await mc.server.run(SETUP, { items: [{ slot: 0, id: "minecraft:oak_planks", count: 4 }] });
    const me = await mc.server.run(SERVER_PLAYER);
    const table = { x: Math.floor(me.position.x) + 2, y: Math.floor(me.position.y), z: Math.floor(me.position.z) };
    await mc.server.run(SET_BLOCK, { pos: table, state: "minecraft:crafting_table" });
    await player.useBlock(mc.client, table, { face: "up" });
    await screen.waitFor(mc.client, "CraftingScreen");

    const view = await host.read(mc.client);
    expect(nodes(view).filter((node) => node.role === "slot")).toHaveLength(46);
    const planks = refOf(view, (node) => node.item?.id === "minecraft:oak_planks");
    expect(host.entry(planks).selector).toEqual({ slot: 37 });
    await act({ ref: planks }, { kind: "click" });
    for (const grid of [1, 2, 4, 5]) {
      await act({ adapter: ui.ADAPTER_ID, selector: { slot: grid } }, { kind: "click", button: "right" });
    }
    // The result slot is the server's answer to the last click: wait for it in the game, then read.
    await mc.client.waitUntil({
      clock: "frame",
      check: `var item = net.minecraft.client.Minecraft.getInstance().player.containerMenu.getSlot(0).getItem();
return item.is(net.minecraft.world.item.Items.CRAFTING_TABLE) ? (Object) true : Wait.pending(item.toString());`,
      timeoutMs: 5_000,
    });
    const crafted = await host.read(mc.client);
    expect(slotItem(crafted, 0)).toEqual({ id: "minecraft:crafting_table", count: 1 });
    expect(formatView(crafted)).toMatch(/slot minecraft:crafting_table /);
    expect(recorded.at(-1)!.code).toBe('await screen.clickSlot(client, 5, {"button":"right"});');
  });

  test("pause and options screens: buttons by label, hover by pointer, waits for present and absent", async () => {
    await input.key(mc.client, { keyCode: GLFW_KEY_ESCAPE });
    await screen.waitFor(mc.client, "PauseScreen");
    const pause = await host.read(mc.client);
    console.log(formatView(pause));
    const options = refOf(pause, (node) => node.role === "button" && (node.name ?? "").startsWith("Options"));
    expect(host.entry(options).selector).toEqual({ label: expect.stringMatching(/^Options/) });

    const clicked = await act({ ref: options }, { kind: "click" });
    expect(clicked.summary).toMatch(/^clicked "Options/);
    expect(clicked.code.code).toMatch(/^await screen\.clickWidget\(client, \{"label":"Options/);
    await host.waitFor(mc.client, { adapter: ui.ADAPTER_ID, selector: { label: "Done" } }, "actionable");

    const settings = await host.read(mc.client);
    const done = refOf(settings, (node) => node.name === "Done");
    const hovered = await act({ ref: done }, { kind: "hover" });
    expect(hovered.summary).toMatch(/^hovering \d+,\d+ \(Done\)$/);
    expect(hovered.code).toMatchObject({ code: expect.stringMatching(/^await input\.move\(client, \{ x: \d+, y: \d+ \}\);$/), warning: "raw coordinates" });

    await act({ ref: done }, { kind: "click" });
    await host.waitFor(mc.client, { ref: done }, "absent");
    await screen.waitFor(mc.client, "PauseScreen");
    await expect(host.waitFor(mc.client, { adapter: ui.ADAPTER_ID, selector: { label: "No such button" } }, "actionable", { timeoutMs: 300 }))
      .rejects.toBeInstanceOf(UiWaitTimeoutError);

    // A bare point goes to the pointer: the centre of "Back to Game" closes the pause screen.
    const back = nodes(await host.read(mc.client)).find((node) => node.name === "Back to Game")!;
    const point = { x: back.bounds.x + back.bounds.width / 2, y: back.bounds.y + back.bounds.height / 2 };
    const closed = await act(point, { kind: "click" });
    expect(closed.code.code).toMatch(/^await input\.click\(client, \{ x: \d+, y: \d+ \}\);$/);
    expect((await host.read(mc.client)).layers).toEqual([]);
  });

  test("chat: text typed into the edit box through the adapter", async () => {
    await input.key(mc.client, { keybind: "key.chat" });
    await screen.waitFor(mc.client, "ChatScreen");
    const view = await host.read(mc.client);
    console.log(formatView(view));
    const box = refOf(view, (node) => node.role === "textbox");
    const typed = await act({ ref: box }, { kind: "type", text: "hello ui" });
    expect(typed.summary).toMatch(/^typed "hello ui" into /);
    expect(typed.code.code).toMatch(/await screen\.clickWidget\(client, .*\); await input\.key\(client, \{ text: "hello ui" \}\);$/);
    const after = await host.read(mc.client);
    expect(nodes(after).find((node) => node.role === "textbox")?.value).toBe("hello ui");
  });

  test("everything codegen produced compiles against @izakyl/blockwright-minecraft", () => {
    expect(recorded.length).toBeGreaterThan(5);
    const imports = new Map<string, Set<string>>();
    for (const code of recorded) {
      for (const { from, names } of code.imports) {
        const set = imports.get(from) ?? new Set<string>();
        names.forEach((name) => set.add(name));
        imports.set(from, set);
      }
    }
    const source = [
      ...[...imports].map(([from, names]) => `import { ${[...names].join(", ")} } from ${JSON.stringify(from)};`),
      'import type { MinecraftClient } from "@izakyl/blockwright-minecraft";',
      "",
      "export async function replay(client: MinecraftClient): Promise<void> {",
      ...recorded.map((code) => `  ${code.code}`),
      "}",
      "",
    ].join("\n");
    const dir = path.join(LIVE_DIR, "test-results");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "ui-codegen.ts");
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(diagnostics, source).toEqual([]);
  });
});
