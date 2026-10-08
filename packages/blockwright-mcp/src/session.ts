import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { crashAwareRetry, errorSummary, listInstances, type PairCloseResult } from "@izakyl/blockwright-client";
import type { BlockwrightInstance, InstanceRecord, InstanceRole, RetryPolicy } from "@izakyl/blockwright-client";
import { camera, evidence, GameLaunchError, launchGame, ui } from "@izakyl/blockwright-minecraft";
import type { Game, LaunchGameOptions, media, MinecraftClient, MinecraftServer } from "@izakyl/blockwright-minecraft";
import type { AnyUiAdapter, UiHost } from "@izakyl/blockwright-ui";
import { UI_SECTIONS } from "./diff.js";
import type { UiSection } from "./diff.js";
import type { RecordedStep } from "./spec.js";

export type McpUiAdapter = AnyUiAdapter<MinecraftClient, ui.Probe>;

export interface SessionOptions {
  config?: string;
  cwd?: string;
  driverPath?: string;
  artifactDir?: string;
  instancePrefix?: string;
  /** How long each instance may take to become ready; default 240000 for the server, 300000 for the client. */
  readyTimeoutMs?: { server?: number; client?: number };
  /** Frames the client renders after an action before it is observed; default 2. */
  settleFrames?: number;
  /** UI adapters drawn over vanilla screens (vanilla is always the bottom layer); default none. */
  adapters?: McpUiAdapter[];
  /**
   * Launch attempts in all (default 2). A failed attempt is retried unless the game left a crash behind
   * (a crash report, JVM crash log or agent crash) — that is a bug, not a hiccup.
   */
  launchAttempts?: number;
  /** Overrides the retry policy {@link launchAttempts} makes. */
  retry?: RetryPolicy;
  /** Replaces the client's `launchPair` under {@link launchGame} (for tests). */
  launcher?: LaunchGameOptions["launcher"];
}

export interface LaunchRequest {
  config?: string;
  restart?: boolean;
  /** Launch attempts in all, for this launch. */
  attempts?: number;
}

const DEFAULT_SETTLE_FRAMES = 2;
const SETTLE_TIMEOUT_MS = 5_000;
const DEFAULT_LAUNCH_ATTEMPTS = 2;

export interface SessionStatus {
  running: boolean;
  config?: string;
  startedAt?: string;
  artifactDir: string;
  instances: Array<{ role: InstanceRole; instanceId: string; instanceDir: string }>;
  ui: Array<{ id: string; off?: string }>;
  /** Launch attempts the last launch retried, with why each failed. */
  retried?: string[];
}

export class SessionNotRunningError extends Error {
  constructor() {
    super("no instance in this session yet — call blockwright_launch to start a server/client pair (about 14 seconds)");
    this.name = "SessionNotRunningError";
  }
}

export class SessionAlreadyRunningError extends Error {
  constructor(instances: string[]) {
    super(
      `this session already holds ${instances.join(" and ")}; blockwright_close it first, or launch `
        + "with restart=true to replace it — a mod rebuilt since the launch only loads in new JVMs",
    );
    this.name = "SessionAlreadyRunningError";
  }
}

/** A recording in progress, and whether a camera path flies with it. */
export interface ActiveRecording {
  recording: media.Recording;
  cameraPath: boolean;
}

/**
 * One MCP session's game: launched through {@link launchGame} (retry, failure evidence, graceful server
 * stop), the prefab handles, the UI host with its refs, the long captures in progress and the
 * recorded steps for export.
 */
export class BlockwrightSession {
  readonly options: SessionOptions;
  readonly ui: UiHost<MinecraftClient, ui.Probe>;

  private game?: Game;
  private observation?: evidence.Observation;
  private launched?: { config?: string; startedAt: string; retried: string[] };
  private shotCounter = 0;
  private sections = new Set<UiSection>(UI_SECTIONS);
  private recorded: RecordedStep[] = [];
  /** Evidence of the last launch's failed attempts. */
  launchFailures: evidence.FailureEvidence[] = [];
  recording?: ActiveRecording;
  sound?: media.SoundCapture;
  readonly draws = new Map<media.DrawChannel, media.DrawCapture>();

  constructor(options: SessionOptions = {}) {
    this.options = options;
    this.ui = ui.host(options.adapters ?? []);
  }

  get cwd(): string {
    return this.options.cwd ?? process.cwd();
  }

  get artifactDir(): string {
    return resolve(this.cwd, this.options.artifactDir ?? "test-results/mcp");
  }

  get running(): boolean {
    return this.game !== undefined;
  }

  get instancePrefix(): string {
    return this.options.instancePrefix ?? "mcp";
  }

  get launchedConfig(): string | undefined {
    return this.launched?.config ?? this.options.config;
  }

  status(): SessionStatus {
    return {
      running: this.running,
      config: this.launchedConfig,
      startedAt: this.launched?.startedAt,
      artifactDir: this.artifactDir,
      instances: this.game
        ? (["server", "client"] as const).map((role) => ({
          role,
          instanceId: this.game!.instances[role].instanceId,
          instanceDir: this.game!.instances[role].instanceDir,
        }))
        : [],
      ui: this.ui.adapters().map(({ id, off }) => ({ id, ...(off === undefined ? {} : { off }) })),
      ...(this.launched && this.launched.retried.length > 0 ? { retried: this.launched.retried } : {}),
    };
  }

  registered(): InstanceRecord[] {
    return listInstances(this.cwd);
  }

  async launch(request: LaunchRequest = {}): Promise<SessionStatus> {
    if (this.game) {
      if (!request.restart) throw new SessionAlreadyRunningError([this.game.server.instanceId, this.game.client.instanceId]);
      await this.close();
    }
    const prefix = this.instancePrefix;
    const config = request.config ?? this.options.config;
    const attempts = request.attempts ?? this.options.launchAttempts ?? DEFAULT_LAUNCH_ATTEMPTS;
    let game: Game;
    try {
      game = await launchGame({
        cwd: this.options.cwd,
        driverPath: this.options.driverPath,
        config,
        server: { instance: `${prefix}-server` },
        client: { instance: `${prefix}-client` },
        ...(this.options.readyTimeoutMs ? { readyTimeoutMs: this.options.readyTimeoutMs } : {}),
        retry: this.options.retry ?? crashAwareRetry(attempts),
        ...(this.options.launcher ? { launcher: this.options.launcher } : {}),
      });
    } catch (error) {
      this.launchFailures = error instanceof GameLaunchError ? error.evidence : [];
      throw error;
    }
    this.launchFailures = game.launchFailures;
    this.game = game;
    this.ui.reset();
    this.observation = undefined;
    await this.ui.verify(game.client);
    this.launched = { config, startedAt: new Date().toISOString(), retried: game.instances.retried.map(errorSummary) };
    this.record({ kind: "launch", config });
    return this.status();
  }

  uiSections(): ReadonlySet<UiSection> {
    return this.sections;
  }

  setUiSection(section: UiSection, enabled: boolean): void {
    if (enabled) this.sections.add(section);
    else this.sections.delete(section);
  }

  record(...steps: RecordedStep[]): void {
    this.recorded.push(...steps);
  }

  steps(): RecordedStep[] {
    return [...this.recorded];
  }

  clearSteps(): void {
    this.recorded = [];
  }

  /** The raw instance of a role. */
  instance(role: InstanceRole = "client"): BlockwrightInstance {
    if (!this.game) throw new SessionNotRunningError();
    return this.game.instances[role];
  }

  /** The prefab handle on the server. */
  server(): MinecraftServer {
    if (!this.game) throw new SessionNotRunningError();
    return this.game.server;
  }

  /** The prefab handle on the client. */
  client(): MinecraftClient {
    if (!this.game) throw new SessionNotRunningError();
    return this.game.client;
  }

  handle(role: InstanceRole): MinecraftServer | MinecraftClient {
    return role === "server" ? this.server() : this.client();
  }

  /** Lets the client catch up with an action (the server's changes received, frames rendered); a verdict line when it could not. */
  async settle(): Promise<string | undefined> {
    try {
      await this.client().settle({
        barrier: true,
        frames: this.options.settleFrames ?? DEFAULT_SETTLE_FRAMES,
        requireNoScreen: false,
        timeoutMs: SETTLE_TIMEOUT_MS,
      });
      return undefined;
    } catch (error) {
      return `client did not draw the result: ${errorSummary(error)}`;
    }
  }

  /** The shared observation: client, server status, and the screen through the UI adapters, as the sections ask. */
  async observe(options: Omit<evidence.ObserveOptions, "server" | "ui"> = {}): Promise<evidence.Observation> {
    const on = (section: UiSection) => this.sections.has(section);
    const observation = await evidence.observe(this.client(), {
      screen: on("screen"),
      player: on("player"),
      cursor: on("cursor"),
      hudText: on("hud"),
      ...(on("messages") ? {} : { messages: false }),
      ...(on("nearby") ? {} : { nearby: false }),
      ...(on("tick") ? { server: this.server() } : {}),
      ...(on("screen") ? { ui: this.ui } : {}),
      ...options,
    });
    this.observation = observation;
    return observation;
  }

  lastObservation(): evidence.Observation | undefined {
    return this.observation;
  }

  forgetObservations(): void {
    this.observation = undefined;
  }

  /** The shared failure evidence, taken from the live game without freezing it; screenshots go to the artifact dir. */
  async evidence(options: evidence.CaptureOptions = {}): Promise<evidence.FailureEvidence> {
    if (!this.game) throw new SessionNotRunningError();
    mkdirSync(this.artifactDir, { recursive: true });
    this.shotCounter += 1;
    return evidence.capture(this.game, {
      freeze: false,
      ui: this.ui,
      dir: this.artifactDir,
      prefix: `${String(this.shotCounter).padStart(3, "0")}-evidence`,
      ...options,
    });
  }

  screenshotPath(label: string): string {
    const dir = this.artifactDir;
    mkdirSync(dir, { recursive: true });
    this.shotCounter += 1;
    const slug = label.replace(/[^0-9A-Za-z_-]+/g, "-").slice(0, 40);
    return resolve(dir, `${String(this.shotCounter).padStart(3, "0")}-${slug || "shot"}.png`);
  }

  artifactPath(label: string, extension: string): string {
    const dir = this.artifactDir;
    mkdirSync(dir, { recursive: true });
    const slug = label.replace(/[^0-9A-Za-z_-]+/g, "-").slice(0, 40) || "capture";
    return resolve(dir, `${slug}.${extension}`);
  }

  /** Ends the long captures still running (without results), then closes the game (server stopped gracefully). */
  async close(): Promise<PairCloseResult | undefined> {
    const game = this.game;
    const recording = this.recording;
    this.recording = undefined;
    await recording?.recording.discard().catch(() => {});
    if (recording?.cameraPath && game) await camera.reset(game.client).catch(() => {});
    await this.sound?.cancel().catch(() => {});
    this.sound = undefined;
    for (const capture of this.draws.values()) await capture.cancel().catch(() => {});
    this.draws.clear();
    this.game = undefined;
    this.observation = undefined;
    this.ui.reset();
    this.launched = undefined;
    return game?.close();
  }
}
