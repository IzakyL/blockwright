import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiHost } from "@izakyl/blockwright-ui";
import { camerasForBounds, type CameraPreset } from "../core/cameras.js";
import { formatDecimal as num } from "../core/format.js";
import type { CameraPose } from "../core/geometry.js";
import type { GameInstance } from "../core/instance.js";
import { minecraft, type MinecraftClient, type MinecraftServer } from "../core/binding.js";
import type { ContainerJson, PlayerJson } from "../core/types.js";
import { screenshot } from "../media/screenshot.js";
import type { MinecraftUiProbe } from "../ui/platform.js";
import { worldContainer, worldEntities, worldNearPlayer } from "../world/queries.js";
import { tickFreeze } from "../world/tick.js";
import type { TickStatus, WorldEntities, WorldPos } from "../world/types.js";
import { formatCrashEvidence, hasCrash, readCrashEvidence, type CrashEvidence } from "./crash.js";
import {
  analyzeGameLog,
  filterGameLog,
  formatGameLogAnalysis,
  formatGameLogEntry,
  readGameLog,
  type GameLogAnalysis,
} from "./logs.js";
import { formatObservation, observe, type Observation } from "./observe.js";

/** The marker that tells the driver to keep an instance's directory past close, for inspection. */
export const FAILURE_MARKER = ".blockwright-failed";

/** Leaves {@link FAILURE_MARKER} in each instance's directory; never throws. */
export function markInstancesFailed(instances: ReadonlyArray<{ instanceDir: string } | undefined>): void {
  for (const instance of instances) {
    if (!instance) continue;
    try {
      writeFileSync(join(instance.instanceDir, FAILURE_MARKER), "failed\n");
    } catch {
    }
  }
}

export interface FailureEvidenceOptions {
  /** Where screenshots are written; default a fresh temporary directory. */
  dir?: string;
  /** Screenshot file name prefix; default `evidence`. */
  prefix?: string;
  /** Freeze the server first, so everything describes one moment (default true). */
  freeze?: boolean;
  /** Observe the client (screen, player, cursor, HUD, chat, nearby entities, server status; default true). */
  observe?: boolean;
  /** Read the open screen through these UI adapters as part of the observation. */
  ui?: UiHost<MinecraftClient, MinecraftUiProbe>;
  /**
   * Screenshots (default true): the player's view, then the camera preset (default `elevations`) framed on the
   * few blocks around the player. False for none.
   */
  screenshots?: boolean | { preset?: CameraPreset; count?: number };
  /** Containers and entities within this many blocks of the player (server side); default 8, 0 for none. */
  radius?: number;
  /** Further containers to dump, wherever they are. */
  containers?: ReadonlyArray<WorldPos | undefined>;
  /** Entities of these types, anywhere, with their NBT. */
  entityTypes?: readonly string[];
  /** Entities listed per query; default 50. */
  entityLimit?: number;
  /** Log analysis plus this many of the newest WARN-or-worse entries per instance (default 20); false for none. */
  logs?: boolean | { tail?: number };
  /** Budget of each in-game step; default 15000 (screenshots: twice that). */
  stepTimeoutMs?: number;
}

export interface InstanceEvidence {
  instanceId: string;
  role: string;
  instanceDir: string;
  tracePath: string;
  /** How the latest process ended and what it left behind (the driver's summaries). */
  crash: CrashEvidence;
  logs?: { analysis: GameLogAnalysis; tail: string[] };
}

export interface EvidenceScreenshot {
  label: string;
  path: string;
  camera: CameraPose | null;
}

export interface FailureEvidence {
  capturedAt: string;
  instances: InstanceEvidence[];
  /** The server's tick state after freezing. */
  tick?: TickStatus;
  observation?: Observation;
  /** The player as the server sees it. */
  player?: PlayerJson;
  /** Containers near the player, then the ones asked for. */
  containers?: ContainerJson[];
  /** Entities near the player (server side). */
  nearbyEntities?: WorldEntities;
  /** Entities of the asked-for types. */
  entities?: WorldEntities;
  screenshots: EvidenceScreenshot[];
  /** What could not be captured, and why. */
  errors: string[];
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]?.slice(0, 300) ?? "unknown error";
}

/** Runs one step within a deadline; a failure (or the deadline) is noted in `errors` and answers undefined. */
async function attempt<T>(errors: string[], label: string, ms: number, step: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`gave up after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([step(controller.signal), deadline]);
  } catch (error) {
    errors.push(`${label}: ${firstLine(error)}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function block(position: { x: number; y: number; z: number }) {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "evidence";
}

/**
 * What a failing test or agent needs to see, from instances that may be half-dead: for each instance how its
 * process ended (crash report and JVM crash summaries from the driver) and its log trouble; and, from those
 * still running, the server frozen at that moment, the client observed (with the UI adapters' reading and the
 * server's status), the player, containers and entities around it, and screenshots of the player's view and
 * of the spot from every side. Nothing here throws: what cannot be captured is listed in `errors`, and each
 * in-game step has its own deadline.
 */
export async function captureFailureEvidence(
  handles: { server?: MinecraftServer; client?: MinecraftClient },
  options: FailureEvidenceOptions = {},
): Promise<FailureEvidence> {
  const errors: string[] = [];
  const stepMs = options.stepTimeoutMs ?? 15_000;
  const evidence: FailureEvidence = { capturedAt: new Date().toISOString(), instances: [], screenshots: [], errors };

  const alive = (handle: MinecraftServer | MinecraftClient | undefined): boolean => {
    if (!handle) return false;
    const instance = handle.instance;
    const crash = readCrashEvidence(instance.tracePath);
    evidence.instances.push({
      instanceId: instance.instanceId,
      role: instance.role,
      instanceDir: instance.instanceDir,
      tracePath: instance.tracePath,
      crash,
    });
    return crash.ended === undefined;
  };
  const server = alive(handles.server) ? handles.server : undefined;
  const client = alive(handles.client) ? handles.client : undefined;

  if (server && options.freeze !== false) {
    evidence.tick = await attempt(errors, "freeze", stepMs, (signal) => tickFreeze(server, true, { signal }));
  }
  if (client && options.observe !== false) {
    evidence.observation = await attempt(errors, "observe", stepMs, (signal) => observe(client, {
      ...(server ? { server } : {}),
      ...(options.ui ? { ui: options.ui } : {}),
      nearby: { radius: 16, limit: 20 },
      signal,
    }));
  }

  const radius = options.radius ?? 8;
  const entityLimit = options.entityLimit ?? 50;
  if (server) {
    const nearby = await attempt(errors, "player and containers", stepMs,
      (signal) => worldNearPlayer(server, { radius, limit: 16, signal }));
    if (nearby?.player) evidence.player = nearby.player;
    const containers = [...(nearby?.containers ?? [])];
    for (const target of options.containers ?? []) {
      if (!target) continue;
      const found = await attempt(errors, `container ${JSON.stringify(target)}`, stepMs,
        (signal) => worldContainer(server, Array.isArray(target) ? target : block(target as { x: number; y: number; z: number }), { signal }));
      if (found) containers.push(found);
    }
    evidence.containers = containers;
    const player = evidence.player;
    if (player && radius > 0) {
      evidence.nearbyEntities = await attempt(errors, "entities near the player", stepMs, (signal) => worldEntities(server, {
        dimension: player.dimension,
        bounds: { center: block(player.position), radius },
        limit: entityLimit,
        signal,
      }));
    }
    if (options.entityTypes && options.entityTypes.length > 0) {
      evidence.entities = await attempt(errors, "entities", stepMs, (signal) => worldEntities(server, {
        types: [...new Set(options.entityTypes)],
        nbt: true,
        limit: entityLimit,
        signal,
      }));
    }
  }

  if (client && options.screenshots !== false) {
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), "bw-evidence-"));
    mkdirSync(dir, { recursive: true });
    const prefix = sanitize(options.prefix ?? "evidence");
    const preset = typeof options.screenshots === "object" ? options.screenshots : {};
    const at = evidence.player?.position ?? evidence.observation?.player?.position;
    const shots: Array<{ label: string; camera: CameraPose | undefined }> = [{ label: "view", camera: undefined }];
    if (at) {
      const pos = block(at);
      const bounds = { min: { x: pos.x - 1, y: pos.y, z: pos.z - 1 }, max: { x: pos.x + 1, y: pos.y + 2, z: pos.z + 1 } };
      for (const { label, ...camera } of camerasForBounds(bounds, preset.preset ?? "elevations", {
        elevation: 25,
        ...(preset.count !== undefined ? { count: preset.count } : {}),
      })) {
        shots.push({ label, camera });
      }
    }
    for (const shot of shots) {
      const path = join(dir, `${prefix}-${shot.label}.png`);
      const taken = await attempt(errors, `screenshot ${shot.label}`, stepMs * 2, (signal) => screenshot(client, {
        path,
        signal,
        ...(shot.camera ? { camera: shot.camera } : {}),
      }));
      if (taken?.path) evidence.screenshots.push({ label: shot.label, path: taken.path, camera: shot.camera ?? null });
    }
  }

  if (options.logs !== false) {
    const tail = typeof options.logs === "object" ? options.logs.tail ?? 20 : 20;
    for (const entry of evidence.instances) {
      try {
        const log = readGameLog(entry);
        entry.logs = {
          analysis: analyzeGameLog(log),
          tail: filterGameLog(log, { level: "WARN" }).slice(-tail).map((each) => formatGameLogEntry(each, 4)),
        };
      } catch (error) {
        errors.push(`logs of ${entry.instanceId}: ${firstLine(error)}`);
      }
    }
  }
  return evidence;
}

/** The evidence as a human report (what the JSON holds, minus the bulk). */
export function formatFailureEvidence(evidence: FailureEvidence): string {
  const lines = [`failure evidence captured at ${evidence.capturedAt}`];
  for (const instance of evidence.instances) {
    const crash = formatCrashEvidence(instance.crash);
    lines.push(`\n${instance.instanceId} (${instance.role}): ${crash.length > 0 ? "" : "running"}`);
    for (const line of crash) lines.push(`  ${line}`);
    lines.push(`  dir ${instance.instanceDir}`, `  trace ${instance.tracePath}`);
  }
  if (evidence.tick) {
    lines.push(`\ntick: ${evidence.tick.frozen ? "frozen" : "running"} at tick ${evidence.tick.tick}, gameTime ${evidence.tick.gameTime}`);
  }
  if (evidence.observation) lines.push("", formatObservation(evidence.observation));
  if (evidence.player) {
    const p = evidence.player;
    lines.push(`\nplayer (server): ${p.name} at ${num(p.position.x)},${num(p.position.y)},${num(p.position.z)} in ${p.dimension}, hp ${num(p.health)}`);
  }
  if (evidence.containers && evidence.containers.length > 0) {
    lines.push(`containers (${evidence.containers.length}):`);
    for (const container of evidence.containers) {
      const items = (container.slots ?? []).map((slot) => `${slot.slot}:${slot.id} x${slot.count}`).join(", ");
      lines.push(`  ${container.pos.x},${container.pos.y},${container.pos.z} ${container.block}: ${items || (container.isContainer ? "empty" : container.reason ?? "not a container")}`);
    }
  }
  for (const [label, entities] of [["entities near the player", evidence.nearbyEntities], ["entities", evidence.entities]] as const) {
    if (!entities) continue;
    lines.push(`${label} (${entities.count}${entities.limited ? `, ${entities.entities.length} listed` : ""}):`);
    for (const entity of entities.entities.slice(0, 20)) {
      lines.push(`  ${entity.type} #${entity.id} at ${num(entity.position.x)},${num(entity.position.y)},${num(entity.position.z)}`);
    }
  }
  if (evidence.screenshots.length > 0) {
    lines.push(`screenshots (${evidence.screenshots.length}):`);
    for (const shot of evidence.screenshots) lines.push(`  ${shot.label}: ${shot.path}`);
  }
  for (const instance of evidence.instances) {
    if (!instance.logs) continue;
    const analysis = formatGameLogAnalysis(instance.logs.analysis);
    if (analysis.length === 0 && instance.logs.tail.length === 0) continue;
    lines.push(`\nlogs of ${instance.instanceId}:`);
    for (const line of analysis) lines.push(`  ${line}`);
    if (instance.logs.tail.length > 0) {
      lines.push(`  newest warnings and errors (${instance.logs.tail.length}):`);
      for (const line of instance.logs.tail) lines.push(`    ${line}`);
    }
  }
  if (evidence.errors.length > 0) {
    lines.push(`\nnot captured (${evidence.errors.length}):`);
    for (const error of evidence.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}

/** A failed launch attempt, as `launchPair`'s `onLaunchFailure` hands it over. */
export interface LaunchFailureLike {
  error: unknown;
  attempt: number;
  server?: GameInstance;
  client?: GameInstance;
}

/**
 * Evidence of a failed launch attempt, for `launchPair({ onLaunchFailure })`: the instances are not ready, so
 * the game is not asked anything; how each process ended, the driver's crash summaries and the logs' trouble
 * are what there is. The failure itself heads `errors`. Also leaves the failure marker, so the driver keeps
 * the instance directories.
 */
export async function captureLaunchFailureEvidence(failure: LaunchFailureLike, options: Pick<FailureEvidenceOptions, "logs"> = {}): Promise<FailureEvidence> {
  markInstancesFailed([failure.server, failure.client]);
  const evidence = await captureFailureEvidence({
    ...(failure.server ? { server: minecraft.server(failure.server) } : {}),
    ...(failure.client ? { client: minecraft.client(failure.client) } : {}),
  }, { ...options, freeze: false, observe: false, screenshots: false, radius: 0 });
  evidence.errors.unshift(`launch attempt ${failure.attempt} failed: ${firstLine(failure.error)}`);
  return evidence;
}

/** Whether a failed launch left a crash behind (a crash report, JVM crash log or agent crash): a bug, not a hiccup. */
export function evidenceShowsCrash(evidence: FailureEvidence | undefined): boolean {
  return evidence?.instances.some((instance) => hasCrash(instance.crash)) ?? false;
}
