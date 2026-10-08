import { BlockwrightRunError, type InstanceRole, type Output } from "@izakyl/blockwright-client";
import type { WaitClock } from "./wait.js";

/** Where a prefab task failed. */
export interface TaskErrorContext {
  /** The template's name, e.g. `reflect.query` or `world.block`. */
  task: string;
  instanceId: string;
  role: InstanceRole;
}

/**
 * A prefab task ended `error` or `cancelled`. `code` is the agent's (`compile`, `exception`, `timeout`,
 * `unavailable`, `limit`, `overflow`, `cancelled`, `no-output`) or the prefab's (see Fail.java:
 * `invalid`, `not-found`, `unavailable`, `wait-timeout`, `settle-timeout`, `reflect`, `hover-mismatch`). The run error is the
 * `cause`. Failures that are not the game's answer (the instance died, the connection dropped) are not
 * wrapped: they surface as the client's own errors.
 */
export class MinecraftTaskError extends Error {
  readonly task: string;
  readonly instanceId: string;
  readonly role: InstanceRole;
  readonly code: string;
  readonly detail?: unknown;
  /** Outputs the task emitted before it failed. */
  readonly outputs: Output[];

  constructor(context: TaskErrorContext, cause: BlockwrightRunError, message?: string) {
    super(message ?? `${context.task} on ${context.role} ${context.instanceId} failed (${cause.code}): ${firstLine(cause)}`,
      { cause });
    this.name = "MinecraftTaskError";
    this.task = context.task;
    this.instanceId = context.instanceId;
    this.role = context.role;
    this.code = cause.code;
    this.detail = cause.detail;
    this.outputs = cause.outputs;
  }
}

export interface CompileDiagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
}

/** The task's Java did not compile: a bug in a template or in Java a caller passed in (a wait check, say). */
export class MinecraftCompileError extends MinecraftTaskError {
  readonly diagnostics: CompileDiagnostic[];

  constructor(context: TaskErrorContext, cause: BlockwrightRunError) {
    const diagnostics = Array.isArray((cause.detail as { diagnostics?: unknown })?.diagnostics)
      ? ((cause.detail as { diagnostics: CompileDiagnostic[] }).diagnostics)
      : [];
    super(context, cause, `${context.task}: its Java does not compile on ${context.role} ${context.instanceId}:\n` +
      (cause.end.status === "error" ? cause.end.error.message : cause.message));
    this.name = "MinecraftCompileError";
    this.diagnostics = diagnostics;
  }
}

/**
 * A condition did not hold in time: `wait-timeout` (an in-game wait: detail `{clock, reason, ticks, elapsedMs,
 * last}`), `settle-timeout` (detail `{stage, ...}`) or the agent's own task deadline `timeout`.
 */
export class MinecraftTimeoutError extends MinecraftTaskError {
  /**
   * wait-timeout: which budget ran out — `timeoutMs` (wall-clock time) or `maxTicks` (ticks of the wait's
   * clock).
   */
  readonly reason?: "timeoutMs" | "maxTicks";
  /** wait-timeout: the clock the wait counted on. */
  readonly clock?: WaitClock;
  /** What the check last saw (wait-timeout), when it reported anything. */
  readonly last?: unknown;
  readonly ticks?: number;
  readonly elapsedMs?: number;
  /** settle-timeout: `epoch`, `frame` or `screen`. */
  readonly stage?: string;

  constructor(context: TaskErrorContext, cause: BlockwrightRunError) {
    super(context, cause);
    this.name = "MinecraftTimeoutError";
    const detail = (cause.detail ?? {}) as Record<string, unknown>;
    this.last = detail.last;
    if (detail.reason === "timeoutMs" || detail.reason === "maxTicks") this.reason = detail.reason;
    if (detail.clock === "server" || detail.clock === "world" || detail.clock === "client" || detail.clock === "frame") {
      this.clock = detail.clock;
    }
    if (typeof detail.ticks === "number") this.ticks = detail.ticks;
    if (typeof detail.elapsedMs === "number") this.elapsedMs = detail.elapsedMs;
    if (typeof detail.stage === "string") this.stage = detail.stage;
  }
}

/** Codes {@link MinecraftTimeoutError} stands for. */
export const TIMEOUT_CODES: ReadonlySet<string> = new Set(["wait-timeout", "settle-timeout", "timeout"]);

/** `error` as a typed prefab error when it is a run error; anything else unchanged. */
export function toMinecraftError(error: unknown, context: TaskErrorContext): unknown {
  if (!(error instanceof BlockwrightRunError)) return error;
  if (error.code === "compile") return new MinecraftCompileError(context, error);
  if (TIMEOUT_CODES.has(error.code)) return new MinecraftTimeoutError(context, error);
  return new MinecraftTaskError(context, error);
}

/** Whether `error` is a prefab task error, optionally with one of `codes`. */
export function isMinecraftError(error: unknown, ...codes: string[]): error is MinecraftTaskError {
  return error instanceof MinecraftTaskError && (codes.length === 0 || codes.includes(error.code));
}

function firstLine(error: Error): string {
  const message = error.message.replace(/^task [^:]+: /, "");
  return message.split("\n")[0] ?? message;
}
