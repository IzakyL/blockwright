import { expect, test } from "@playwright/test";
import { coverageReport, coverageReset } from "@izakyl/blockwright-client";
import { defineTask, javaTask, launchGame } from "@izakyl/blockwright-minecraft";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { LIVE_DIR, liveConfig } from "./helpers.js";

/**
 * Coverage of a mod under test, end to end: a game launched with `[coverage]` on (measuring LDLib2) records what
 * ran, and the report attributes it to LDLib2's own classes and, through the code its mixins merge into
 * Minecraft's classes, to its mixin sources; Minecraft's own classes stay out of it.
 */

const CONFIG = liveConfig("blockwright-coverage.toml");
const COVERAGE_DIR = path.join(LIVE_DIR, ".blockwright", "coverage-live");
const LD = "com.lowdragmc.lowdraglib2.gui";

/** A ModularUIScreen with a status label and a button. */
const OPEN_PANEL = defineTask<void, string>({
  name: "test.coverage.open",
  side: "client",
  source: javaTask({
    imports: [
      "net.minecraft.client.Minecraft",
      "net.minecraft.network.chat.Component",
      `${LD}.ui.UI`,
      `${LD}.ui.UIElement`,
      `${LD}.ui.ModularUI`,
      `${LD}.ui.elements.Button`,
      `${LD}.ui.elements.Label`,
      `${LD}.holder.ModularUIScreen`,
    ],
    body: `
Minecraft mc = (Minecraft) ctx.client();
UIElement root = new UIElement();
root.layout(l -> l.width(200).height(80));
Label status = new Label();
status.setText("idle");
status.setId("cov.status");
Button press = new Button();
press.setText("Press");
press.setId("cov.press");
press.layout(l -> l.width(80).height(16));
press.setOnClick(e -> status.setText("pressed"));
root.addChildren(status, press);
mc.setScreen(new ModularUIScreen(ModularUI.of(UI.of(root), mc.player), Component.literal("coverage")));
return mc.screen.getClass().getName();`,
  }),
});

interface LcovFile {
  found: number;
  hit: number;
}

function readLcov(file: string): Map<string, LcovFile> {
  const files = new Map<string, LcovFile>();
  let current: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("SF:")) {
      current = line.slice(3);
      files.set(current, { found: 0, hit: 0 });
    } else if (current && line.startsWith("DA:")) {
      const entry = files.get(current)!;
      entry.found += 1;
      if (Number(line.split(",")[1]) > 0) entry.hit += 1;
    }
  }
  return files;
}

function sourcePath(className: string): string {
  return `${className.replace(/\$.*$/, "").replaceAll(".", "/")}.java`;
}

test("a game with [coverage] on reports the mod's classes and its mixins", async ({}, testInfo) => {
  test.setTimeout(900_000);
  await coverageReset({ cwd: LIVE_DIR, config: CONFIG });

  const game = await launchGame({
    cwd: LIVE_DIR,
    config: CONFIG,
    server: { trace: "test-results/coverage-server.ndjson", instance: "coverage-s" },
    client: { trace: "test-results/coverage-client.ndjson", instance: "coverage-c" },
  });
  try {
    expect(await game.client.run(OPEN_PANEL)).toBe(`${LD}.holder.ModularUIScreen`);
  } finally {
    await game.close();
  }

  const out = testInfo.outputPath("coverage");
  const summary = await coverageReport({ cwd: LIVE_DIR, config: CONFIG, out });
  console.log(summary);
  await testInfo.attach("coverage-summary.txt", { body: summary, contentType: "text/plain" });
  expect(existsSync(path.join(out, "html", "index.html"))).toBe(true);
  expect(existsSync(path.join(out, "jacoco.xml"))).toBe(true);

  const lcov = readLcov(path.join(out, "lcov.info"));
  // The button that was built ran.
  expect(lcov.get(sourcePath(`${LD}.ui.elements.Button`))?.hit ?? 0).toBeGreaterThan(0);
  // Minecraft's classes are only measured for the mixin code merged into them; they are not reported.
  expect([...lcov.keys()].filter((file) => file.startsWith("net/minecraft/"))).toEqual([]);

  // The launch's plan names LDLib2's mixins: they are reported under their own sources, and some of them ran.
  const plansDir = path.join(COVERAGE_DIR, "plans");
  const newest = readdirSync(plansDir)
    .map((name) => path.join(plansDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const plan = JSON.parse(readFileSync(newest, "utf8")) as { mixins: string[] };
  const mixins = plan.mixins.map(sourcePath).filter((file) => lcov.has(file));
  expect(mixins.length).toBeGreaterThan(0);
  const ran = mixins.filter((file) => lcov.get(file)!.hit > 0);
  console.log(`mixin sources ran: ${ran.length}/${mixins.length}: ${ran.slice(0, 10).join(", ")}`);
  expect(ran.length).toBeGreaterThan(0);
});
