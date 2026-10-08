import { createConnection, type Socket } from "node:net";
import {
  BlockwrightConnectionClosedError,
  BlockwrightGameRequestError,
  BlockwrightRequestTimeoutError,
} from "./errors.js";
import type { RequestOptions } from "./types-core.js";
import type { Output, RunController, RunEnd, RunFailure, RunHandle, TaskSpec } from "./run.js";

export const GAME_PROTOCOL = "blockwright-game";

/** What the driver's `game.connect` returns. */
export interface GameConnection {
  protocol: typeof GAME_PROTOCOL;
  host: string;
  port: number;
  token: string;
}

export interface GameChannelOptions {
  /** How long the TCP connect plus welcome may take. Default 10s. */
  handshakeTimeoutMs?: number;
  /**
   * Unconsumed binary output bytes past which the client stops reading the connection until
   * outputs are consumed (it resumes at half). Default 64 MiB; `Infinity` never pauses.
   */
  highWaterBytes?: number;
  /** Longest JSON line accepted. Default 64 MiB. */
  maxLineBytes?: number;
  /** Largest binary frame accepted. Default 1 GiB. */
  maxBinaryBytes?: number;
  /**
   * Slack after a task's own `timeoutMs` before the client stops waiting for the agent to end the
   * run: it then asks to cancel and ends the run `error` with code `unresponsive`. Default 10s.
   */
  backstopMarginMs?: number;
}

/** The agent's deadline for a task that sets no `timeoutMs` (neoforge-agent/API.md). */
export const DEFAULT_TASK_TIMEOUT_MS = 15_000;

/** Default slack on top of a task's own deadline before the client gives up on the agent ending it. */
export const RUN_BACKSTOP_MARGIN_MS = 10_000;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;

interface LiveRun {
  controller: RunController;
  timer?: NodeJS.Timeout;
}

interface PendingRequest {
  op: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

interface BinaryFrame {
  run: number;
  meta: unknown;
  size: number;
  parts: Buffer[];
  received: number;
}

/**
 * One game-channel connection to an agent (neoforge-agent/API.md, "Wire protocol"): concurrent runs
 * keyed by their request id, and request/reply for `cancel`, `load`, `unload` and `status`. Frames are
 * parsed from raw bytes, so a binary payload may arrive split across any number of TCP chunks.
 */
export class GameChannel {
  readonly #socket: Socket;
  readonly #options: Required<GameChannelOptions>;
  readonly #runs = new Map<number, LiveRun>();
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #failure?: Error;
  #closeListeners: Array<(error: Error) => void> = [];

  #welcomed = false;
  #lineParts: Buffer[] = [];
  #lineBytes = 0;
  #binary?: BinaryFrame;
  #held = 0;
  #paused = false;

  private constructor(socket: Socket, options: GameChannelOptions) {
    this.#socket = socket;
    this.#options = {
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      highWaterBytes: options.highWaterBytes ?? 64 * MIB,
      maxLineBytes: options.maxLineBytes ?? 64 * MIB,
      maxBinaryBytes: options.maxBinaryBytes ?? 1024 * MIB,
      backstopMarginMs: options.backstopMarginMs ?? RUN_BACKSTOP_MARGIN_MS,
    };
  }

  static connect(connection: GameConnection, options: GameChannelOptions = {}): Promise<GameChannel> {
    if (!connection || connection.protocol !== GAME_PROTOCOL || typeof connection.host !== "string" || !connection.host
      || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535
      || typeof connection.token !== "string" || !connection.token) {
      return Promise.reject(new Error(`invalid game connection descriptor: ${JSON.stringify(connection)}`));
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: connection.host, port: connection.port });
      socket.setNoDelay(true);
      const channel = new GameChannel(socket, options);
      let settled = false;
      const timer = setTimeout(
        () => channel.#fail(new BlockwrightConnectionClosedError("game handshake timed out")),
        channel.#options.handshakeTimeoutMs,
      );
      channel.onClose((error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      channel.#onWelcome = () => {
        clearTimeout(timer);
        settled = true;
        resolve(channel);
      };
      socket.on("data", (chunk: Buffer) => {
        try {
          channel.#receive(chunk);
        } catch (error) {
          channel.#fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => channel.#fail(new BlockwrightConnectionClosedError(`game connection failed: ${error.message}`, { cause: error })));
      socket.on("close", () => channel.#fail(new BlockwrightConnectionClosedError()));
      socket.once("connect", () => socket.write(JSON.stringify({ token: connection.token }) + "\n"));
    });
  }

  #onWelcome?: () => void;

  /** Why the channel closed, once it has. */
  get failure(): Error | undefined {
    return this.#failure;
  }

  get closed(): boolean {
    return this.#failure !== undefined;
  }

  /** Runs not yet ended. */
  get liveRuns(): number {
    return this.#runs.size;
  }

  /** Calls `listener` once, with the reason, when the channel closes (at once if it already has). */
  onClose(listener: (error: Error) => void): void {
    if (this.#failure) listener(this.#failure);
    else this.#closeListeners.push(listener);
  }

  /** Starts `task`; its outputs and end go to `controller`. */
  run(task: TaskSpec, controller: RunController): RunHandle {
    if (typeof task?.source !== "string" || task.source.length === 0) {
      throw new TypeError("a task needs its Java source");
    }
    if (this.#failure) {
      controller.fail(this.#failure);
      return { cancel: async () => {} };
    }
    const id = this.#nextId++;
    const live: LiveRun = { controller };
    this.#runs.set(id, live);
    const deadline = typeof task.timeoutMs === "number" ? task.timeoutMs : DEFAULT_TASK_TIMEOUT_MS;
    if (deadline > 0) {
      const margin = this.#options.backstopMarginMs;
      const budget = deadline + margin;
      live.timer = setTimeout(() => {
        if (this.#runs.get(id) !== live) return;
        this.#runs.delete(id);
        void this.request("cancel", { run: id }).catch(() => {});
        controller.end({
          status: "error",
          error: {
            code: "unresponsive",
            message: `the agent did not end the run within its ${deadline}ms deadline plus ${margin}ms`,
          },
        });
      }, budget);
      live.timer.unref?.();
    }
    this.#write({ id, op: "run", task: wireTask(task) });
    return {
      cancel: async () => {
        if (this.#runs.get(id) !== live || this.#failure) return;
        try {
          await this.request("cancel", { run: id });
        } catch (error) {
          // A run that ended meanwhile is no longer known to the agent; the end frame says how it went.
          if (!(error instanceof BlockwrightGameRequestError)) throw error;
        }
      },
    };
  }

  /** A request answered by `{id, result}` or `{id, error}`: `cancel`, `load`, `unload`, `status`. */
  request<T = unknown>(op: string, body: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = this.#nextId++;
    const timeoutMs = options.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : options.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { op, resolve: resolve as (value: unknown) => void, reject };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          // A late reply is dropped as an orphan; the connection stays usable for everything else.
          this.#pending.delete(id);
          reject(new BlockwrightRequestTimeoutError(op, timeoutMs));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      this.#write({ ...body, id, op });
    });
  }

  /** Closes the connection; the agent cancels every live run of it. Pending work fails with `reason`. */
  close(reason: Error = new BlockwrightConnectionClosedError()): void {
    this.#fail(reason);
  }

  #write(frame: Record<string, unknown>): void {
    try {
      this.#socket.write(JSON.stringify(frame) + "\n", (error) => {
        if (error) this.#fail(new BlockwrightConnectionClosedError(`game connection write failed: ${error.message}`, { cause: error }));
      });
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.#failure) {
      const binary = this.#binary;
      if (binary) {
        const take = Math.min(binary.size - binary.received, chunk.length - offset);
        binary.parts.push(chunk.subarray(offset, offset + take));
        binary.received += take;
        offset += take;
        if (binary.received === binary.size) {
          this.#binary = undefined;
          this.#deliverBinary(binary);
        }
        continue;
      }
      const newline = chunk.indexOf(0x0a, offset);
      if (newline === -1) {
        const rest = chunk.subarray(offset);
        this.#lineBytes += rest.length;
        if (this.#lineBytes > this.#options.maxLineBytes) {
          throw new Error(`game frame exceeds ${this.#options.maxLineBytes} bytes without a newline`);
        }
        this.#lineParts.push(rest);
        return;
      }
      const tail = chunk.subarray(offset, newline);
      const line = this.#lineParts.length > 0 ? Buffer.concat([...this.#lineParts, tail]) : tail;
      this.#lineParts = [];
      this.#lineBytes = 0;
      offset = newline + 1;
      const text = line.toString("utf8").trim();
      if (text) this.#frame(text);
    }
  }

  #frame(text: string): void {
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      throw new Error(`malformed game frame: ${text.slice(0, 200)}`);
    }
    if (typeof frame !== "object" || frame === null) throw new Error(`malformed game frame: ${text.slice(0, 200)}`);

    if (!this.#welcomed) {
      if (frame.type !== "welcome" || frame.protocol !== GAME_PROTOCOL) {
        throw new BlockwrightConnectionClosedError(`game handshake refused: ${text.slice(0, 200)}`);
      }
      this.#welcomed = true;
      this.#onWelcome?.();
      return;
    }

    if (typeof frame.run === "number") {
      if (typeof frame.bytes === "number") {
        if (!Number.isInteger(frame.bytes) || frame.bytes < 0 || frame.bytes > this.#options.maxBinaryBytes) {
          throw new Error(`invalid binary frame size ${frame.bytes}`);
        }
        const binary: BinaryFrame = { run: frame.run, meta: frame.meta ?? null, size: frame.bytes, parts: [], received: 0 };
        if (binary.size === 0) this.#deliverBinary(binary);
        else this.#binary = binary;
        return;
      }
      const live = this.#runs.get(frame.run);
      if ("out" in frame) {
        live?.controller.output({ kind: "json", value: frame.out });
        return;
      }
      if (typeof frame.end === "string") {
        // `duplicate: true` ends a run request the agent refused because a live run already used its id: this
        // client never reuses ids, so the run it knows under that id is the refused one and ends here, while the
        // agent's live run goes on and its later frames, having no run here, are dropped.
        if (!live) return;
        this.#runs.delete(frame.run);
        if (live.timer) clearTimeout(live.timer);
        live.controller.end(runEnd(frame));
        return;
      }
      throw new Error(`unknown run frame: ${text.slice(0, 200)}`);
    }

    if (typeof frame.id === "number" && ("result" in frame || "error" in frame)) {
      const pending = this.#pending.get(frame.id);
      if (!pending) return; // answered after its timeout
      this.#pending.delete(frame.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.error) pending.reject(new BlockwrightGameRequestError(pending.op, frame.error));
      else pending.resolve(frame.result);
      return;
    }
    throw new Error(`unknown game frame: ${text.slice(0, 200)}`);
  }

  #deliverBinary(binary: BinaryFrame): void {
    const live = this.#runs.get(binary.run);
    if (!live) return;
    const data = binary.parts.length === 1 ? binary.parts[0] : Buffer.concat(binary.parts, binary.size);
    const output: Output = { kind: "bytes", data, meta: binary.meta };
    this.#hold(data.length);
    let released = false;
    live.controller.output(output, () => {
      if (released) return;
      released = true;
      this.#hold(-data.length);
    });
  }

  #hold(delta: number): void {
    this.#held += delta;
    if (!this.#paused && this.#held > this.#options.highWaterBytes) {
      this.#paused = true;
      this.#socket.pause();
    } else if (this.#paused && this.#held <= this.#options.highWaterBytes / 2) {
      this.#paused = false;
      if (!this.#failure) this.#socket.resume();
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#socket.destroy();
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    const runs = [...this.#runs.values()];
    this.#runs.clear();
    for (const live of runs) {
      if (live.timer) clearTimeout(live.timer);
      live.controller.fail(error);
    }
    const listeners = this.#closeListeners;
    this.#closeListeners = [];
    for (const listener of listeners) listener(error);
  }
}

function wireTask(task: TaskSpec): Record<string, unknown> {
  const wire: Record<string, unknown> = { source: task.source };
  if (task.thread !== undefined) wire.thread = task.thread;
  if (task.args !== undefined) wire.args = task.args;
  if (task.timeoutMs !== undefined) wire.timeoutMs = task.timeoutMs;
  if (task.limits !== undefined) wire.limits = task.limits;
  return wire;
}

function runEnd(frame: { end: string; error?: Partial<RunFailure> }): RunEnd {
  if (frame.end === "ok") return { status: "ok" };
  if (frame.end === "cancelled") return { status: "cancelled" };
  const error = frame.error ?? {};
  return {
    status: "error",
    error: {
      code: typeof error.code === "string" ? error.code : frame.end === "error" ? "unknown" : frame.end,
      message: typeof error.message === "string" ? error.message : "the task failed",
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    },
  };
}
