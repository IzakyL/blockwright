import type { RunEnd, RunFailure, Output } from "./run.js";

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** An error the Rust driver answered a stdio request with. */
export class BlockwrightRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, payload: JsonRpcErrorPayload) {
    // The message may carry frames after its first line; the call it came from belongs on that line.
    const [headline, ...frames] = payload.message.split("\n");
    super([`${headline} (JSON-RPC ${payload.code} from ${method})`, ...frames].join("\n"));
    this.name = "BlockwrightRpcError";
    this.method = method;
    this.code = payload.code;
    this.data = payload.data;
  }
}

/** An error the game agent answered a `cancel`, `load`, `unload` or `status` request with. */
export class BlockwrightGameRequestError extends Error {
  readonly op: string;
  readonly code: string;

  constructor(op: string, payload: { code?: unknown; message?: unknown }) {
    const code = typeof payload.code === "string" ? payload.code : String(payload.code ?? "unknown");
    const message = typeof payload.message === "string" ? payload.message : `${op} failed`;
    const [headline, ...frames] = message.split("\n");
    super([`${headline} (${code} from ${op})`, ...frames].join("\n"));
    this.name = "BlockwrightGameRequestError";
    this.op = op;
    this.code = code;
  }
}

/**
 * A run that ended `error` or `cancelled`, thrown by iterating it or by its `outputs()`, `last()` and
 * `result()`. `code` is the agent's (`compile`, `exception`, `timeout`, `unavailable`, ...), `cancelled`,
 * `unresponsive` (the client's backstop gave up on the agent) or `no-output` (from `result()`).
 */
export class BlockwrightRunError extends Error {
  readonly end: RunEnd;
  readonly code: string;
  readonly detail?: unknown;
  /** The outputs a helper (`outputs()`, `last()`, `result()`) had collected before the end. */
  outputs: Output[] = [];

  constructor(end: RunEnd | { status: "error"; error: RunFailure }) {
    const failure: RunFailure = end.status === "error"
      ? end.error
      : end.status === "cancelled"
        ? { code: "cancelled", message: "the run was cancelled" }
        : { code: "no-output", message: "the run ended ok without a JSON output" };
    super(`task ${failure.code}: ${failure.message}`);
    this.name = "BlockwrightRunError";
    this.end = end;
    this.code = failure.code;
    this.detail = failure.detail;
  }
}

/** The game connection closed (or could not be opened) while something waited on it. */
export class BlockwrightConnectionClosedError extends Error {
  constructor(message = "game connection closed", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BlockwrightConnectionClosedError";
  }
}

/** Whether `error` is the game's own answer, rather than a call failing to reach it. */
export function isAgentAnswer(error: unknown): boolean {
  return error instanceof BlockwrightRunError || error instanceof BlockwrightGameRequestError;
}

export class BlockwrightRequestTimeoutError extends Error {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`request ${method} timed out after ${timeoutMs}ms`);
    this.name = "BlockwrightRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class BlockwrightInstanceGoneError extends Error {
  readonly instanceId: string;
  readonly role: string;
  readonly waitingFor: string;
  readonly elapsedMs: number;
  readonly reason: string;
  readonly details: string[];

  constructor(input: {
    instanceId: string;
    role: string;
    waitingFor: string;
    elapsedMs: number;
    reason: string;
    details: string[];
  }) {
    const lines = [
      `instance ${input.instanceId} (${input.role}) ended while waiting for ${input.waitingFor}: ${input.reason}`,
      `waited ${input.elapsedMs}ms`,
      ...input.details.map((line) => `  | ${line}`),
    ];
    super(lines.join("\n"));
    this.name = "BlockwrightInstanceGoneError";
    this.instanceId = input.instanceId;
    this.role = input.role;
    this.waitingFor = input.waitingFor;
    this.elapsedMs = input.elapsedMs;
    this.reason = input.reason;
    this.details = input.details;
  }
}

export function errorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0]?.slice(0, 200) ?? "unknown error";
}

export function errorToString(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
    : String(error);
}
