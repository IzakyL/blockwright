import { test as base, expect } from "@playwright/test";
import type { TestInfo } from "@playwright/test";
import { basename } from "node:path";
import type { InstanceLaunchOptions, InstanceRole } from "@izakyl/blockwright-client";
import { evidence, GameLaunchError, launchGame, ui as minecraftUi, world } from "@izakyl/blockwright-minecraft";
import type { Game, LaunchGameOptions, MinecraftClient, MinecraftServer } from "@izakyl/blockwright-minecraft";
import type { AnyUiAdapter, UiHost } from "@izakyl/blockwright-ui";

export { expect };
export { defineConfig } from "@playwright/test";

/** How failure evidence is taken (screenshots, radius, logs...); targets and the UI host come from the fixtures. */
export type EvidenceSettings = Omit<evidence.CaptureOptions, "dir" | "containers" | "entityTypes" | "ui">;

/** Where failure evidence looks beyond the player; the test adds to these while it runs. */
export interface FailureEvidenceTargets {
  containers: world.Pos[];
  entityTypes: string[];
}

export interface GameTestFixtures {
  /** The prefab handle on the server: pass it to @izakyl/blockwright-minecraft's functions. */
  server: MinecraftServer;
  /** The prefab handle on the client. */
  client: MinecraftClient;
  /** The launched game; its raw instances and driver are `game.instances`. */
  game: Game;
  /** The UI host (vanilla screens plus the adapters given to createGameTest); failure evidence reads the screen through it. */
  ui: UiHost<MinecraftClient, minecraftUi.Probe>;
  /** Evidence targets the test adds to while it runs; read when it fails. */
  failureEvidence: FailureEvidenceTargets;
}

export interface GameTestOptions extends Omit<LaunchGameOptions, "launchEvidence"> {
  /** Instances launch as <prefix>-<role>-<runId> unless `server.instance`/`client.instance` name them; default the spec file's name. */
  instancePrefix?: string;
  /** Trace files go here, named after the instance (default test-results); null lets the driver pick. */
  traceDir?: string | null;
  /** Default `BW_RUN_ID`, else derived from the test's title. */
  runId?: string;
  /** UI adapters beyond vanilla screens (a UI library's panels, ...), in drawing order. */
  uiAdapters?: readonly AnyUiAdapter<MinecraftClient, minecraftUi.Probe>[];
  /** How failure evidence is taken; false takes none (launch failures included). */
  evidence?: EvidenceSettings | false;
}

/**
 * Playwright fixtures on {@link launchGame}: `server` and `client` (prefab handles), `game`, `ui` and
 * `failureEvidence`, one game per test, named after it. A failing test gets its evidence attached
 * (`failure-evidence.json`, `failure-evidence.txt`, screenshots); a failed launch gets
 * `launch-failure-evidence.*`; a crash the driver found is attached either way.
 */
export function createGameTest(options: GameTestOptions = {}) {
  const { instancePrefix, traceDir = "test-results", runId: fixedRunId, uiAdapters, evidence: settings, ...launch } = options;

  return base.extend<GameTestFixtures>({
    failureEvidence: [
      async ({}, use) => {
        await use({ containers: [], entityTypes: [] });
      },
      { scope: "test" },
    ],

    ui: [
      async ({}, use) => {
        await use(minecraftUi.host(uiAdapters ?? []));
      },
      { scope: "test" },
    ],

    game: [
      async ({ failureEvidence, ui }, use, testInfo) => {
        const runId = sanitizeRunId(fixedRunId ?? process.env.BW_RUN_ID ?? testInstanceKey(testInfo.title)) + copySuffix(testInfo);
        const prefix = instancePrefix ?? basename(testInfo.file).replace(/\.spec\.[tj]s$/, "");
        const role = (name: InstanceRole): InstanceLaunchOptions => {
          const own = launch[name];
          const instance = own?.instance ?? `${prefix}-${name}-${runId}`;
          return { ...own, instance, ...(traceDir === null ? {} : { trace: `${traceDir}/${instance}.ndjson` }) };
        };
        let game: Game;
        try {
          game = await launchGame({ ...launch, launchEvidence: settings !== false, server: role("server"), client: role("client") });
        } catch (error) {
          if (error instanceof GameLaunchError && error.evidence.length > 0) {
            await attachLaunchFailures(testInfo, [], error.evidence);
          }
          throw error;
        }
        try {
          await use(game);
        } finally {
          try {
            if (game.launchFailures.length > 0) {
              await attachLaunchFailures(testInfo, game.instances.retried, game.launchFailures);
            }
            if (settings !== false && testFailed(testInfo)) {
              evidence.markFailed([game.instances.server, game.instances.client]);
              await attachFailureEvidence(testInfo, game, {
                ...settings,
                ui,
                containers: failureEvidence.containers,
                entityTypes: [...new Set(failureEvidence.entityTypes)],
              });
            }
          } finally {
            try {
              await game.close();
            } finally {
              await attachCrashes(testInfo, game);
            }
          }
        }
      },
      { scope: "test" },
    ],

    server: [async ({ game }, use) => use(game.server), { scope: "test" }],
    client: [async ({ game }, use) => use(game.client), { scope: "test" }],
  });
}

export interface AttachFailureEvidenceOptions extends evidence.CaptureOptions {
  /** A caught error: evidence is taken even though the test's status says it passed. */
  error?: unknown;
}

/**
 * Captures failure evidence (`evidence.capture` of @izakyl/blockwright-minecraft) from the handles and attaches it:
 * `failure-evidence.json`, `failure-evidence.txt` and each screenshot. Does nothing unless the test failed or
 * `error` is given; never throws (what goes wrong is attached as `failure-evidence-error.txt`).
 */
export async function attachFailureEvidence(
  testInfo: TestInfo,
  handles: { server?: MinecraftServer; client?: MinecraftClient },
  options: AttachFailureEvidenceOptions = {},
): Promise<evidence.FailureEvidence | undefined> {
  const { error, ...captureOptions } = options;
  if (error === undefined && !testFailed(testInfo)) return undefined;
  try {
    const taken = await evidence.capture(handles, { ...captureOptions, dir: captureOptions.dir ?? testInfo.outputPath() });
    await attachJson(testInfo, "failure-evidence.json", taken);
    await attachText(testInfo, "failure-evidence.txt", evidence.format(taken));
    for (const shot of taken.screenshots) {
      await testInfo.attach(basename(shot.path), { path: shot.path, contentType: "image/png" });
    }
    return taken;
  } catch (captureError) {
    const ids = [handles.server, handles.client].filter(Boolean).map((handle) => handle!.instanceId).join(", ");
    await attachText(testInfo, "failure-evidence-error.txt",
      `failure evidence could not be captured from [${ids}]: ${describeError(captureError)}`);
    return undefined;
  }
}

/** Whether the test failed unexpectedly (a `test.fail()` that failed did not). */
function testFailed(testInfo: TestInfo): boolean {
  const statusFailed = testInfo.status !== undefined && testInfo.status !== testInfo.expectedStatus;
  return statusFailed || (testInfo.errors?.length ?? 0) > 0;
}

async function attachLaunchFailures(testInfo: TestInfo, retried: unknown[], failures: evidence.FailureEvidence[]): Promise<void> {
  if (retried.length > 0) {
    await attachText(testInfo, "retried-launches.txt", retried.map(describeError).join("\n\n---\n\n"));
  }
  await attachJson(testInfo, "launch-failure-evidence.json", failures);
  await attachText(testInfo, "launch-failure-evidence.txt", failures.map(evidence.format).join("\n\n---\n\n"));
}

/** After close: a crash the driver found (crash report, JVM crash log) is attached whether or not the test failed. */
async function attachCrashes(testInfo: TestInfo, game: Game): Promise<void> {
  for (const instance of [game.instances.server, game.instances.client]) {
    const crash = evidence.readCrash(instance.tracePath);
    if (evidence.hasCrash(crash)) {
      await attachText(testInfo, `crash-${instance.role}.txt`, [`${instance.instanceId} (${instance.role})`, ...evidence.formatCrash(crash)].join("\n"));
    }
  }
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^0-9A-Za-z_-]+/g, "-").slice(0, 32);
}

function testInstanceKey(title: string): string {
  const slug = title.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= 24) return slug || "test";
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) {
    hash = (hash * 31 + title.charCodeAt(index)) >>> 0;
  }
  return `${slug.slice(0, 24)}-${hash.toString(36)}`;
}

/**
 * Tells apart the copies Playwright makes of one test (`--repeat-each`, retries), which would otherwise
 * launch under the same instance name and refuse each other's directory. The first run keeps the plain name.
 */
function copySuffix(testInfo: { repeatEachIndex: number; retry: number }): string {
  return (testInfo.repeatEachIndex > 0 ? `-r${testInfo.repeatEachIndex}` : "")
    + (testInfo.retry > 0 ? `-t${testInfo.retry}` : "");
}

async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  try {
    await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
  } catch {
  }
}

async function attachText(testInfo: TestInfo, name: string, body: string): Promise<void> {
  try {
    await testInfo.attach(name, { body, contentType: "text/plain" });
  } catch {
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
