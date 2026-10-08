import { expect, test } from "@playwright/test";
import { BlockwrightSession } from "@izakyl/blockwright-mcp";
import { callTool as call } from "./helpers";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The MCP drives vanilla screens through the UI host (chat, inventory slots, shift-click), each by ref, and
 * exports the adapter's own calls.
 */

const LIVE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(LIVE_DIR, "blockwright-offscreen.toml");
const OUT = path.join(LIVE_DIR, "test-results/mcp-ui");
const EXPORTED = path.join(OUT, "exported.spec.ts");

function ref(text: string, pattern: RegExp): string {
  const found = pattern.exec(text);
  if (!found?.[1]) throw new Error(`no ${pattern} in:\n${text}`);
  return found[1];
}

test("the MCP drives vanilla screens by ref, and exports the adapter's calls", async () => {
  test.setTimeout(900_000);
  rmSync(OUT, { recursive: true, force: true });
  const session = new BlockwrightSession({ cwd: LIVE_DIR, config: CONFIG, instancePrefix: "mcp-ui", artifactDir: OUT });
  try {
    const launched = await call(session, "blockwright_launch");
    expect(launched).toMatch(/ui adapters: minecraft$/m);
    await call(session, "blockwright_command", { commands: ["clear @a", "give @a minecraft:diamond 5", "gamemode survival @a"] });
    // The server moves on before every screen action below, so GUI clicks are not held back.
    await call(session, "blockwright_tick", { ticks: 5 });

    // Chat: open it, type into the edit box it shows, submit.
    const chat = await call(session, "blockwright_key", { keybind: "key.chat" });
    const input = ref(chat, /\[(e\d+)\] textbox/);
    const said = await call(session, "blockwright_ui", { op: "type", ref: input, text: "hello from the ui host", submit: true });
    expect(said).toMatch(/and pressed enter/);
    expect(said).toMatch(/hello from the ui host/);
    expect(said).toMatch(/screen: ChatScreen .* -> none/);

    // Inventory: slots come back as refs keyed by menu index.
    const opened = await call(session, "blockwright_key", { keybind: "key.inventory" });
    expect(opened).toMatch(/screen: none -> InventoryScreen/);
    const diamonds = ref(opened, /\[(e\d+)\] slot minecraft:diamond x5/);
    await call(session, "blockwright_tick", { ticks: 5 });

    const picked = await call(session, "blockwright_ui", { ref: diamonds });
    expect(picked).toMatch(/cursor: .*carrying minecraft:diamond x5/);
    expect(picked).toMatch(new RegExp(`\\[${diamonds}\\] slot minecraft:diamond x5 .* -> slot `));
    const placed = await call(session, "blockwright_ui", { ref: diamonds });
    expect(placed).toMatch(new RegExp(`\\[${diamonds}\\] slot .* -> slot minecraft:diamond x5`));

    // A shift-click moves the stack between hotbar and main inventory: the old slot empties.
    const shifted = await call(session, "blockwright_ui", { ref: diamonds, modifiers: ["shift"] });
    expect(shifted).toMatch(/shift\+click/);
    expect(shifted).toMatch(new RegExp(`\\[${diamonds}\\] slot minecraft:diamond x5 .* -> slot \\d`));
    expect(shifted).toMatch(/\[e\d+\] slot .* -> slot minecraft:diamond x5/);

    const full = await call(session, "blockwright_observe", { mode: "full" });
    expect(full).toMatch(/\nui: .*\n {2}minecraft:\n/);
    expect(full).toMatch(/empty slots: e\d+/);
    await call(session, "blockwright_key", { keybind: "key.inventory" });

    await call(session, "blockwright_export", { op: "spec", name: "mcp ui replay", path: EXPORTED });
    const spec = readFileSync(EXPORTED, "utf8");
    expect(spec).toMatch(/await screen\.clickSlot\(client, \d+, \{"modifiers":\["shift"\]\}\);/);
    expect(spec).toContain('await input.key(client, { keybind: "key.inventory" });');
    expect(spec).toMatch(/await screen\.clickWidget\(client, \{.*\}\); await input\.key\(client, \{ text: "hello from the ui host" \}\); await input\.key\(client, \{ keyCode: 257 \}\);/);
  } finally {
    await session.close();
  }
});
