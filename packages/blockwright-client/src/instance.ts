import { resolve } from "node:path";
import type { BlockwrightDriver } from "./driver.js";
import {
  BlockwrightConnectionClosedError,
  BlockwrightInstanceGoneError,
  errorSummary,
  isAgentAnswer,
} from "./errors.js";
import { GameChannel, type GameChannelOptions, type GameConnection } from "./game-channel.js";
import { releaseInstance } from "./driver.js";
import { dumpThreads, hostLoad } from "./host.js";
import { delay, PROCESS_START_EVENTS, READY_EVENT, terminalReason, TraceLog } from "./instance-helpers.js";
import { poll } from "./poll.js";
import { Run, type RunHandle, type RunOptions, type TaskSpec, type TaskThread } from "./run.js";
import type { RequestOptions, TraceEvent, WaitForReadyOptions, WaitOptions } from "./types-core.js";
import type { InstanceCloseOptions, InstanceCloseResult, InstanceLaunchResult, InstanceRole } from "./types-launch.js";
import { ModuleLedger, moduleHash, type ModuleSpec } from "./modules.js";

/** What {@link BlockwrightInstance.ensureModules} did. */
export interface EnsureModulesResult {
  /** Modules sent to the agent by this call (the agent may still have answered `cached`). */
  loaded: string[];
  /** Modules this connection had already loaded with the same sources. */
  skipped: string[];
}

/** A module by name, or every module. */
export type UnloadTarget = string | { all: true };

/** The agent's answer to `load`. */
export interface ModuleLoadResult {
  name: string;
  /** The key compiled code is cached by: a hash of the sources and the modules compiled against. */
  version: string;
  /** Binary class names, sorted. */
  classes: string[];
  /** A module of that name was loaded before. */
  replaced: boolean;
  /** The same sources were already loaded against the same modules; nothing was compiled. */
  cached: boolean;
  compileMs: number;
  /** Modules loaded after this one that were recompiled against the new copy. */
  relinked: string[];
  /** Modules loaded after this one that no longer compile, with why. */
  unusable: Record<string, string>;
}

/** The agent's answer to `unload`: the modules it removed. */
export interface ModuleUnloadResult {
  unloaded: string[];
}

/** One loaded module, as {@link InstanceStatus} reports it. */
export interface ModuleStatus {
  name: string;
  version: string;
  /** Source paths. */
  files: string[];
  /** How many classes it compiled to. */
  classes: number;
  compileMs: number;
  ageMs: number;
  /** `name@version` of each module it was compiled against. */
  compiledAgainst: string[];
  /** It was compiled against a module version that is no longer the loaded one. */
  stale: boolean;
  /** Why it no longer compiles after a module it references was replaced; absent while usable. */
  unusable?: string;
}

/** One live run of this connection, as {@link InstanceStatus} reports it. */
export interface RunStatus {
  /** The run's request id. */
  run: number;
  thread: TaskThread;
  state: "starting" | "live" | "closing" | "ended";
  ageMs: number;
  /** Binary outputs dropped by the task's drop policy so far. */
  droppedBinary: number;
}

/** The agent's answer to `status`. */
export interface InstanceStatus {
  protocol: "blockwright-game";
  /** The process has a server (a dedicated server, or a client's integrated one). */
  server: boolean;
  /** The process is a client. */
  client: boolean;
  compiler: { available: boolean; cachedTasks: number };
  /** In load order. */
  modules: ModuleStatus[];
  /** This connection's live runs. */
  runs: RunStatus[];
  /** Live runs over all connections. */
  liveRuns: number;
  /** This connection's queued binary output. */
  queuedBinaryBytes: number;
  limits: { maxRunsPerConnection: number; maxQueuedBinaryBytes: number; maxQueuedJsonBytes: number };
}

/** Load requests compile in the game, so they get a longer default budget than other requests. */
const LOAD_TIMEOUT_MS = 120_000;

/** Package-internal (not exported from the index): an instance's trace log, and dropping it when its driver goes. */
export let traceLogOf!: (instance: BlockwrightInstance) => TraceLog;
export let abandonInstance!: (instance: BlockwrightInstance) => void;

/**
 * One game process, client or server: its lifecycle, and the task runtime inside it. It has no
 * Minecraft semantics; prefabs build those on {@link run} and {@link load}.
 */
export class BlockwrightInstance {
  readonly instanceId: string;
  readonly role: InstanceRole;
  readonly tracePath: string;
  readonly instanceDir: string;

  static {
    traceLogOf = (instance) => instance.#log();
    abandonInstance = (instance) => instance.#abandon();
  }

  readonly #driver: BlockwrightDriver;
  readonly #channelOptions: GameChannelOptions;
  #traceLog?: TraceLog;
  #channel?: Promise<GameChannel>;
  readonly #ledgers = new WeakMap<GameChannel, ModuleLedger>();
  #closed = false;
  #closing?: Promise<InstanceCloseResult>;

  constructor(driver: BlockwrightDriver, launch: InstanceLaunchResult, channelOptions: GameChannelOptions = {}) {
    this.#driver = driver;
    this.#channelOptions = channelOptions;
    this.instanceId = launch.instanceId;
    this.role = launch.role;
    this.tracePath = resolve(driver.cwd, launch.tracePath);
    this.instanceDir = launch.instanceDir;
  }

  /** The instance's trace file (logs, lifecycle and agent events), read incrementally. */
  #log(): TraceLog {
    return (this.#traceLog ??= new TraceLog(this.tracePath));
  }

  /**
   * Runs `task` in the game. The returned {@link Run} streams the task's outputs and says how it
   * ended; it starts at once, whether or not anything consumes it. If the game process dies or the
   * connection drops first, the run fails with {@link BlockwrightInstanceGoneError} (or the
   * connection error when the process is still there).
   */
  run<T = unknown>(task: TaskSpec, options: RunOptions = {}): Run<T> {
    if (typeof task?.source !== "string" || task.source.length === 0) {
      throw new TypeError("a task needs its Java source");
    }
    const started = Date.now();
    const signal = options.signal;
    return new Run<T>((controller) => {
      let handle: RunHandle | undefined;
      let cancelled = false;
      let ended = false;
      const onAbort = () => void cancel().catch(() => {});
      const finish = () => {
        ended = true;
        signal?.removeEventListener("abort", onAbort);
      };
      const cancel = async () => {
        if (ended) return;
        cancelled = true;
        if (handle) await handle.cancel();
      };
      const sink = {
        output: controller.output,
        end: (end: Parameters<typeof controller.end>[0]) => {
          finish();
          controller.end(end);
        },
        fail: (error: unknown) => {
          finish();
          void this.#explainFailure("a task run", error, started).then(controller.fail, () => controller.fail(error));
        },
      };
      if (signal?.aborted) {
        sink.end({ status: "cancelled" });
        return { cancel: async () => {} };
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#connect().then((channel) => {
        if (ended) return;
        if (cancelled) {
          sink.end({ status: "cancelled" });
          return;
        }
        handle = channel.run(task, sink);
      }, sink.fail);
      return { cancel };
    });
  }

  /**
   * Loads (or replaces, for new tasks) a module of library Java source. The default budget is 120s,
   * since the game compiles it.
   */
  async load(module: ModuleSpec, options: RequestOptions = {}): Promise<ModuleLoadResult> {
    if (!module || typeof module.name !== "string" || !module.name || typeof module.sources !== "object") {
      throw new TypeError("a module needs a name and its sources");
    }
    const answer = await this.#request<ModuleLoadResult>("load", { module: { name: module.name, sources: module.sources } },
      { timeoutMs: LOAD_TIMEOUT_MS, ...options });
    // A direct load replaces the module, so ensureModules must see it as loaded with these sources.
    (await this.#currentLedger())?.record(module.name, moduleHash(module));
    return answer;
  }

  /**
   * Loads each module unless this connection already loaded it with the same sources, in the order
   * given (put a module after the modules it references). Concurrent calls are serialised.
   *
   * The record is per game connection: after a reconnect every module is sent again, which the agent
   * answers as a cheap no-op (`cached`) when it still has it — and loads for real when the game
   * process is a new one. Loading a module with changed sources also forgets every module this
   * connection loaded after it, so those are recompiled against the new copy when next ensured.
   * {@link unload} forgets what it unloads.
   */
  async ensureModules(modules: readonly ModuleSpec[], options: RequestOptions = {}): Promise<EnsureModulesResult> {
    const started = Date.now();
    let channel: GameChannel;
    try {
      channel = await this.#connect();
    } catch (error) {
      throw await this.#explainFailure("the answer to load", error, started);
    }
    let ledger = this.#ledgers.get(channel);
    if (!ledger) this.#ledgers.set(channel, (ledger = new ModuleLedger()));
    const record = ledger;
    return record.serial(async () => {
      const result: EnsureModulesResult = { loaded: [], skipped: [] };
      for (const module of modules) {
        const hash = moduleHash(module);
        if (record.has(module.name, hash)) {
          result.skipped.push(module.name);
          continue;
        }
        try {
          await channel.request("load", { module: { name: module.name, sources: module.sources } },
            { timeoutMs: LOAD_TIMEOUT_MS, ...options });
        } catch (error) {
          throw await this.#explainFailure("the answer to load", error, started);
        }
        record.record(module.name, hash);
        result.loaded.push(module.name);
      }
      return result;
    });
  }

  /** Unloads one module by name, or all of them. */
  async unload(target: UnloadTarget, options: RequestOptions = {}): Promise<ModuleUnloadResult> {
    const body = typeof target === "string" ? { module: target } : { all: true };
    const answer = await this.#request<ModuleUnloadResult>("unload", body, options);
    const ledger = await this.#currentLedger();
    if (typeof target === "string") ledger?.forget(target);
    else ledger?.forgetAll();
    return answer;
  }

  /** The module record of the open connection, if one is open. */
  async #currentLedger(): Promise<ModuleLedger | undefined> {
    const current = this.#channel;
    if (!current) return undefined;
    try {
      return this.#ledgers.get(await current);
    } catch {
      return undefined;
    }
  }

  /** The agent's own report on its runs and modules. */
  async status(options: RequestOptions = {}): Promise<InstanceStatus> {
    return this.#request<InstanceStatus>("status", {}, options);
  }

  async #request<T>(op: string, body: Record<string, unknown>, options: RequestOptions): Promise<T> {
    const started = Date.now();
    try {
      const channel = await this.#connect();
      return await channel.request<T>(op, body, options);
    } catch (error) {
      throw await this.#explainFailure(`the answer to ${op}`, error, started);
    }
  }

  /** The game connection, opened on first use and again after it dropped. */
  #connect(): Promise<GameChannel> {
    if (this.#closed) {
      return Promise.reject(new BlockwrightConnectionClosedError(`instance ${this.instanceId} is closed`));
    }
    const current = this.#channel;
    if (current) return current;
    const opening = this.#driver.request<GameConnection>("game.connect", { instanceId: this.instanceId })
      .then((descriptor) => GameChannel.connect(descriptor, this.#channelOptions))
      .then((channel) => {
        if (this.#closed || this.#channel !== opening) {
          channel.close();
          throw new BlockwrightConnectionClosedError(`instance ${this.instanceId} is closed`);
        }
        channel.onClose(() => {
          if (this.#channel === opening) this.#channel = undefined;
        });
        return channel;
      });
    this.#channel = opening;
    opening.catch(() => {
      if (this.#channel === opening) this.#channel = undefined;
    });
    return opening;
  }

  /** Drops the game connection (the agent cancels its live runs); the next call opens a new one. */
  disconnect(): void {
    const channel = this.#channel;
    this.#channel = undefined;
    void channel?.then((open) => open.close(), () => {});
  }

  /**
   * A failure that did not come from the game itself (a dropped connection, a timeout) turns into
   * {@link BlockwrightInstanceGoneError}, with exit and crash evidence, when the process is gone.
   */
  async #explainFailure(waitingFor: string, error: unknown, started: number): Promise<unknown> {
    if (this.#closed || isAgentAnswer(error) || error instanceof BlockwrightInstanceGoneError) return error;
    const log = this.#log();
    // The driver notices an exit within a few hundred milliseconds; give it that long to say so.
    for (let waited = 0; ; waited += 250) {
      log.poll();
      const reason = log.terminal();
      if (reason) {
        const gone = new BlockwrightInstanceGoneError({
          instanceId: this.instanceId,
          role: this.role,
          waitingFor,
          elapsedMs: Date.now() - started,
          reason,
          details: [...log.diagnostics.summarize(), `the call failed with: ${errorSummary(error)}`],
        });
        (gone as Error & { cause?: unknown }).cause = error;
        return gone;
      }
      if (waited >= 1500) return error;
      await delay(250);
    }
  }

  /**
   * Waits for the agent's readiness event from the latest game process: a server whose world has ticked, a
   * client in a loaded level. Throws {@link BlockwrightInstanceGoneError} if the process ends first.
   */
  async waitForReady(options: WaitForReadyOptions = {}): Promise<void> {
    // Only the process started last counts: a ready (or death) from before a restart is stale.
    const connectStallMs = this.role === "client" ? (options.connectStallMs ?? 90_000) : undefined;
    await this.#waitForTrace(
      READY_EVENT,
      { timeoutMs: options.timeoutMs ?? 120_000, pollMs: options.pollMs },
      (event) => PROCESS_START_EVENTS.has(event.name),
      connectStallMs,
    );
  }

  /**
   * Waits for the next trace event named `name` (default budget 30s). Throws
   * {@link BlockwrightInstanceGoneError} if the process ends first.
   */
  waitForTrace(name: string, options: WaitOptions = {}): Promise<TraceEvent> {
    return this.#waitForTrace(name, options);
  }

  async #waitForTrace(
    name: string,
    options: WaitOptions,
    startsAt?: (event: TraceEvent) => boolean,
    connectStallMs?: number,
  ): Promise<TraceEvent> {
    const log = this.#log();
    const description = `trace event ${name}`;
    const started = Date.now();
    let cursor = 0;
    if (startsAt) {
      log.poll();
      cursor = log.lastPosition(startsAt);
    }

    const found = await poll<TraceEvent>(
      () => {
        const output = log.poll();
        if (connectStallMs !== undefined) this.#checkConnectStall(log, connectStallMs, description, started);
        const kept = log.since(cursor);
        cursor = kept.next;
        for (const event of kept.events) {
          if (event.name === name) {
            return event;
          }
          const reason = terminalReason(event);
          if (reason) {
            throw new BlockwrightInstanceGoneError({
              instanceId: this.instanceId,
              role: this.role,
              waitingFor: description,
              elapsedMs: Date.now() - started,
              reason,
              details: log.diagnostics.summarize(),
            });
          }
        }
        return output.find((event) => event.name === name);
      },
      {
        label: description,
        timeoutMs: options.timeoutMs ?? 30_000,
        pollMs: options.pollMs ?? 250,
      },
    );
    if (found.matched && found.value) {
      return found.value;
    }

    const lastEventName = log.diagnostics.lastEventName;
    throw new Error(
      `timed out waiting for ${description} on instance ${this.instanceId} (${this.role})` +
        ` after ${found.elapsedMs}ms; trace=${log.path}` +
        (lastEventName ? `, last trace event=${lastEventName}` : "") +
        this.#stallReport(log),
    );
  }

  /**
   * Waits until the latest game process has ended (the driver's `process.died`, or `process.exit` once it was
   * closed) and answers that event, or undefined when it still runs after `timeoutMs` (default 30000).
   */
  async waitForExit(options: WaitOptions = {}): Promise<TraceEvent | undefined> {
    const log = this.#log();
    log.poll();
    const found = await poll<TraceEvent>(
      () => {
        log.poll();
        const start = log.lastPosition((event) => PROCESS_START_EVENTS.has(event.name));
        return log.since(start).events.find((event) => event.name === "process.died" || event.name === "process.exit");
      },
      { label: "process exit", timeoutMs: options.timeoutMs ?? 30_000, pollMs: options.pollMs ?? 200 },
    );
    return found.matched ? found.value : undefined;
  }

  /** What the game was doing when a wait gave up: its last output, the machine's load, and its thread stacks. */
  #stallReport(log: TraceLog): string {
    const lines = [`\n${hostLoad()}`];
    const recent = log.diagnostics.recentLines;
    if (recent.length > 0) {
      lines.push(`last output (${Math.round((Date.now() - log.diagnostics.lastEventAt) / 1000)}s ago):`);
      lines.push(...recent.map((line) => `  | ${line}`));
    }
    const dump = dumpThreads(log.diagnostics.pid, log.diagnostics.command, log.path);
    if (dump) lines.push(`thread dump: ${dump}`);
    return lines.join("\n");
  }

  /**
   * A client that logged "Connecting to" and then nothing for `stallMs` never got a login answer;
   * waiting out the full readiness budget would only delay the same failure.
   */
  #checkConnectStall(log: TraceLog, stallMs: number, description: string, started: number): void {
    const recent = log.diagnostics.recentLines;
    const last = recent[recent.length - 1];
    if (last === undefined || !/Connecting to \S+/.test(last)) return;
    const quietMs = Date.now() - log.diagnostics.lastEventAt;
    if (quietMs < stallMs) return;
    throw new Error(
      `instance ${this.instanceId} (client) stalled while waiting for ${description}: nothing happened for ` +
        `${Math.round(quietMs / 1000)}s after "${last.trim()}", so the server never answered the login ` +
        `(waited ${Date.now() - started}ms in all; trace=${log.path})` +
        this.#stallReport(log),
    );
  }

  /**
   * Closes the game connection (cancelling its runs), then has the driver stop the process; answers how it
   * ended. Later calls wait for the first and answer its result (undefined if it failed, or when the
   * instance was abandoned instead).
   */
  close(options: InstanceCloseOptions = {}): Promise<InstanceCloseResult | undefined> {
    if (this.#closing) return this.#closing.catch(() => undefined);
    if (this.#closed) return Promise.resolve(undefined);
    this.#closed = true;
    this.#closing = this.#closeNow(options);
    return this.#closing;
  }

  async #closeNow(options: InstanceCloseOptions): Promise<InstanceCloseResult> {
    const channel = this.#channel;
    this.#channel = undefined;
    await channel?.then(
      (open) => open.close(new BlockwrightConnectionClosedError(`instance ${this.instanceId} was closed`)),
      () => {},
    );
    try {
      return await this.#driver.request<InstanceCloseResult>("lifecycle.close", {
        instanceId: this.instanceId,
        ...(options.keepInstanceDir ? { keepProjection: true } : {}),
        ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      });
    } finally {
      releaseInstance(this.#driver, this);
    }
  }

  /** The driver shut down: drop the connection without asking it to close the process. */
  #abandon(): void {
    this.#closed = true;
    this.disconnect();
  }
}
