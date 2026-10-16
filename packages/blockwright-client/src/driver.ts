import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isRecord } from "./instance-helpers.js";
import { resolveBinaryPath, resolveBundledAgent } from "./binary.js";
import { BlockwrightRequestTimeoutError, BlockwrightRpcError } from "./errors.js";
import type { GameChannelOptions } from "./game-channel.js";
import { abandonInstance, BlockwrightInstance } from "./instance.js";
import type { RequestOptions } from "./types-core.js";
import type { InstanceLaunchOptions, InstanceLaunchResult, InstanceRole } from "./types-launch.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface DriverOptions {
  /** The `blockwright` binary; default `$BLOCKWRIGHT_CLI`, the bundled one, else `blockwright` on PATH. */
  driverPath?: string;
  /** Arguments before the `driver` subcommand, for an executable wrapper (for example Node plus a script). */
  driverArgs?: readonly string[];
  /** The driver's working directory, which relative config and trace paths resolve against. Default `process.cwd()`. */
  cwd?: string;
  /** Default budget for a driver request that sets none; default 35000, null for none. Launch and close are never bounded. */
  requestTimeoutMs?: number | null;
  /** Budget for EOF shutdown including game saves and output draining; default 75000. Timeout forces driver termination and rejects closeAsync. */
  closeTimeoutMs?: number;
  /** Options for every instance's game connection. */
  game?: GameChannelOptions;
}

/** A line on the driver's stdout that answered nothing. */
export interface DriverProtocolDiagnostic {
  kind: "malformed-response" | "orphan-response";
  line: string;
  detail: string;
}

/** Package-internal (not exported from the index): an instance tells its driver it closed. */
export let releaseInstance!: (driver: BlockwrightDriver, instance: BlockwrightInstance) => void;

export class BlockwrightDriver {
  readonly process: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly protocolDiagnostics: DriverProtocolDiagnostic[] = [];

  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private methods = new Map<number, string>();
  private instances = new Set<BlockwrightInstance>();
  private holds = 0;
  private activeLaunches = 0;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly completion: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  private readonly closeTimeoutMs: number;
  private readonly channelOptions: GameChannelOptions;
  /** The driver answers one request at a time, so requests queue here and time out from when they are sent. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set once a request outlived its budget: the driver may still be busy with it, so later requests fail fast. */
  private failure?: Error;
  private stdoutChunks: Buffer[] = [];
  private readonly requestTimeoutMs: number | null;

  static {
    releaseInstance = (driver, instance) => driver.#release(instance);
  }

  constructor(options: DriverOptions = {}) {
    this.channelOptions = options.game ?? {};
    const driverPath = resolveBinaryPath(options.driverPath);
    this.cwd = options.cwd ?? process.cwd();
    this.requestTimeoutMs = options.requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.requestTimeoutMs;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    if (!Number.isFinite(this.closeTimeoutMs) || this.closeTimeoutMs <= 0) {
      throw new RangeError("closeTimeoutMs must be a positive finite number");
    }
    this.process = spawn(driverPath, [...(options.driverArgs ?? []), "driver"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });

    this.process.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr.pipe(process.stderr);
    // A pipe can fail while the child is exiting. Handle its error even after pending requests ended.
    this.process.stdin.on("error", (error) => {
      this.failure ??= error;
      this.rejectAllPending(this.failure);
    });
    this.completion = new Promise((resolve) => {
      let processError: Error | undefined;
      this.process.on("error", (error) => {
        processError ??= error;
        this.failure ??= error;
        this.rejectAllPending(this.failure);
      });
      this.process.once("exit", (code, signal) => {
        this.failure ??= new Error(`blockwright driver exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
        this.rejectAllPending(this.failure);
        this.abandonInstances();
      });
      // Unlike exit, close means the child has ended AND its output pipes have drained.
      this.process.once("close", (code, signal) => resolve({ code, signal, error: processError }));
    });
  }

  async launchNeoForge(role: InstanceRole, options: InstanceLaunchOptions = {}): Promise<BlockwrightInstance> {
    this.activeLaunches++;
    try {
      const result = await this.request<InstanceLaunchResult>("neoforge.launch", {
        config: options.config,
        role,
        instance: options.instance,
        trace: options.trace,
        agentMod: options.agentMod ?? resolveBundledAgent("neoforge"),
        startFrozen: options.startFrozen ?? true,
        ...(options.reuseInstanceDir ? { reuseInstanceDir: true } : {}),
        ...(options.keepInstanceDir ? { keepInstanceDir: true } : {}),
      });

      if (this.closing) throw new Error("blockwright driver is closing");
      const instance = new BlockwrightInstance(this, result, this.channelOptions);
      this.instances.add(instance);
      return instance;
    } finally {
      this.activeLaunches--;
      this.closeIfIdle();
    }
  }

  ping(options: RequestOptions = {}): Promise<unknown> {
    return this.request("ping", {}, options);
  }

  /**
   * One driver RPC over stdio: `ping`, `neoforge.launch`, `lifecycle.close` or `game.connect`. The
   * driver answers one request at a time, so requests queue and each budget starts when it is sent.
   */
  request<T = unknown>(method: DriverMethod, params?: unknown, options: RequestOptions = {}): Promise<T> {
    if (this.closing) return Promise.reject(new Error("blockwright driver is closing"));
    if (!DRIVER_METHODS.has(method)) {
      return Promise.reject(new Error(`${method} is not a driver method; game work goes through instance.run`));
    }
    const sent = this.queue.then(() => this.send<T>(method, params, options));
    this.queue = sent.catch(() => {});
    return sent;
  }

  private send<T>(method: string, params: unknown, options: RequestOptions): Promise<T> {
    if (this.closing) return Promise.reject(new Error("blockwright driver is closing"));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const message = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    const timeoutMs = resolveRequestTimeoutMs(method, options, this.requestTimeoutMs);

    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        this.methods.delete(id);
        this.failure ??= new BlockwrightRequestTimeoutError(method, timeoutMs);
        rejectRequest(this.failure);
      }, timeoutMs);
      timer?.unref();

      const settle = (finish: () => void) => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        finish();
      };

      this.pending.set(id, {
        resolve: (value) => settle(() => resolveRequest(value as T)),
        reject: (error) => settle(() => rejectRequest(error)),
      });
      this.methods.set(id, method);
      this.process.stdin.write(`${message}\n`, (error) => {
        if (error) {
          const pending = this.pending.get(id);
          this.pending.delete(id);
          this.methods.delete(id);
          if (pending) {
            pending.reject(error);
          }
        }
      });
    });
  }

  private recordProtocolDiagnostic(kind: DriverProtocolDiagnostic["kind"], line: string, detail: string): void {
    const diagnostic: DriverProtocolDiagnostic = {
      kind,
      line: line.length > PROTOCOL_DIAGNOSTIC_LINE_LIMIT
        ? `${line.slice(0, PROTOCOL_DIAGNOSTIC_LINE_LIMIT)}…`
        : line,
      detail,
    };
    if (this.protocolDiagnostics.length >= MAX_PROTOCOL_DIAGNOSTICS) {
      this.protocolDiagnostics.shift();
    }
    this.protocolDiagnostics.push(diagnostic);
    process.emitWarning(`blockwright driver ${kind}: ${detail} | ${diagnostic.line}`);
  }

  /** Starts cooperative EOF shutdown. Use closeAsync to wait and observe cleanup failures. */
  close(): void {
    void this.closeAsync();
  }

  /** Stops accepting work, sends stdin EOF, and waits for the driver and its output to close. Repeated calls share one promise. */
  closeAsync(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.rejectAllPending(new Error("blockwright driver is closing"));
    this.abandonInstances();
    this.process.stdin.end();
    this.closePromise = this.waitForShutdown();
    // close() and idle shutdown deliberately do not await; explicit callers still receive the rejection.
    void this.closePromise.catch(() => {});
    return this.closePromise;
  }

  private abandonInstances(): void {
    const instances = [...this.instances];
    this.instances.clear();
    for (const instance of instances) abandonInstance(instance);
  }

  private waitForShutdown(): Promise<void> {
    return new Promise((resolve, reject) => {
      let timedOut: Error | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        timedOut = new Error(`blockwright driver shutdown timed out after ${this.closeTimeoutMs}ms; forced termination was required`);
        if (this.process.exitCode === null && this.process.signalCode === null) {
          try {
            this.process.kill("SIGKILL");
          } catch (cause) {
            timedOut = new Error(`${timedOut.message}; termination failed`, { cause });
          }
        }
        // A leaked inherited pipe or failed kill must not make closeAsync hang forever.
        forceTimer = setTimeout(() => {
          this.process.stdin.destroy();
          this.process.stdout.destroy();
          this.process.stderr.destroy();
          reject(new Error(`${timedOut!.message}; process/output did not close within ${FORCE_CLOSE_TIMEOUT_MS}ms`));
        }, FORCE_CLOSE_TIMEOUT_MS);
      }, this.closeTimeoutMs);
      this.completion.then(({ code, signal, error }) => {
        clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        if (timedOut) reject(timedOut);
        else if (error) reject(error);
        else if (code !== 0 || signal !== null) {
          reject(new Error(`blockwright driver shutdown failed with code ${code ?? "null"} signal ${signal ?? "null"}`));
        } else resolve();
      });
    });
  }

  /**
   * Keeps the driver running while no instance is open (it otherwise exits with its last instance),
   * until the returned function is called.
   */
  retain(): () => void {
    if (this.closing) throw new Error("blockwright driver is closing");
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.closeIfIdle();
    };
  }

  /** An instance closed; the driver exits with its last one. */
  #release(instance: BlockwrightInstance): void {
    if (!this.instances.delete(instance)) return;
    this.closeIfIdle();
  }

  private closeIfIdle(): void {
    if (this.instances.size === 0 && this.holds === 0 && this.activeLaunches === 0) {
      this.close();
    }
  }

  private handleStdout(chunk: Buffer): void {
    if (chunk.indexOf(0x0a) === -1) {
      this.stdoutChunks.push(chunk);
      return;
    }
    const buffer =
      this.stdoutChunks.length > 0 ? Buffer.concat([...this.stdoutChunks, chunk]) : chunk;
    this.stdoutChunks.length = 0;

    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline === -1) {
        if (start < buffer.length) {
          this.stdoutChunks.push(buffer.subarray(start));
        }
        return;
      }

      const line = buffer.subarray(start, newline).toString("utf8").trim();
      start = newline + 1;
      if (!line) {
        continue;
      }

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch (cause) {
        this.recordProtocolDiagnostic(
          "malformed-response",
          line,
          cause instanceof Error ? cause.message : String(cause),
        );
        continue;
      }

      if (!isRecord(response) || typeof response.id !== "number") {
        this.recordProtocolDiagnostic("malformed-response", line, "response has no numeric id");
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) {
        this.recordProtocolDiagnostic("orphan-response", line, `no pending request with id ${response.id}`);
        continue;
      }
      const method = this.methods.get(response.id) ?? "unknown";
      this.pending.delete(response.id);
      this.methods.delete(response.id);

      if (response.error) {
        pending.reject(new BlockwrightRpcError(method, response.error));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.methods.clear();
  }
}

/** Backstop for a driver request that declares no budget. */
const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 75_000;
const FORCE_CLOSE_TIMEOUT_MS = 5_000;
const PROTOCOL_DIAGNOSTIC_LINE_LIMIT = 200;
const MAX_PROTOCOL_DIAGNOSTICS = 100;

export type DriverMethod = "ping" | "neoforge.launch" | "lifecycle.close" | "game.connect";

/** The driver's whole stdio surface: lifecycle only. Game traffic never goes through the driver. */
const DRIVER_METHODS: ReadonlySet<string> = new Set<DriverMethod>(["ping", "neoforge.launch", "lifecycle.close", "game.connect"]);

/** Operations bounded by the game process rather than a budget; its exit ends them. */
const UNBOUNDED_METHODS: ReadonlySet<string> = new Set<DriverMethod>(["neoforge.launch", "lifecycle.close"]);

export function resolveRequestTimeoutMs(
  method: string,
  options: RequestOptions,
  defaultTimeoutMs: number | null,
): number | null {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  if (UNBOUNDED_METHODS.has(method)) return null;
  return defaultTimeoutMs;
}
