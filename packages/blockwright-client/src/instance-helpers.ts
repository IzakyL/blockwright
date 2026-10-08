import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import type { TraceEvent } from "./types-core.js";

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function terminalReason(event: TraceEvent): string | undefined {
  const data = (event.data ?? {}) as { code?: number | null; signal?: number | string | null };
  switch (event.name) {
    case "process.died":
      return `process exited on its own (code=${data.code ?? "null"}, signal=${data.signal ?? "null"})`;

    case "process.exit":
      return `process was stopped (code=${data.code ?? "null"}, signal=${data.signal ?? "null"})`;

    case "neoforge.jvm_shutdown":
      return "JVM entered shutdown";
    default:
      return undefined;
  }
}

const FATAL_LINE_PATTERNS: RegExp[] = [
  /FAILED TO BIND TO PORT/i,
  /Address already in use/i,
  /is not installed/i,
  /Missing or unsupported mandatory dependencies/i,
  /Failed to start the minecraft server/i,
  /A fatal error has occurred/i,
  /Caused by: /,
  /Exception in thread/i,
];

export class InstanceDeathDiagnostics {
  static readonly MAX_LINES = 12;
  static readonly RECENT_LINES = 8;

  lastEventName?: string;
  /** When the newest event arrived, by this process's clock. */
  lastEventAt = Date.now();
  /** The game process id, from the driver's `process.started`. */
  pid?: number;
  /** The command that started the game, from `process.spawn`. */
  command?: string;
  readonly recentLines: string[] = [];
  readonly #fatalLines: string[] = [];
  #crash?: string;
  #evidence: string[] = [];

  observe(event: TraceEvent): void {
    this.lastEventName = event.name;
    const at = Date.parse(event.ts);
    this.lastEventAt = Number.isNaN(at) ? Date.now() : at;
    if (event.name === "process.stdout" || event.name === "process.stderr") {
      const line = (event.data as { line?: unknown } | undefined)?.line;
      if (typeof line === "string") {
        this.recentLines.push(line.trimEnd());
        if (this.recentLines.length > InstanceDeathDiagnostics.RECENT_LINES) this.recentLines.shift();
      }
      if (typeof line === "string" && FATAL_LINE_PATTERNS.some((p) => p.test(line))) {
        if (this.#fatalLines.length < InstanceDeathDiagnostics.MAX_LINES) {
          this.#fatalLines.push(line.trim());
        }
      }
      return;
    }
    if (event.name === "process.spawn" || event.name === "process.restart") {
      const command = (event.data as { command?: unknown } | undefined)?.command;
      if (typeof command === "string") this.command = command;
      this.#evidence = [];
      return;
    }
    if (event.name === "process.started") {
      const pid = (event.data as { pid?: unknown } | undefined)?.pid;
      if (typeof pid === "number") this.pid = pid;
      return;
    }
    if (event.name === "process.died") {
      this.#evidence = crashEvidence(event.data);
      return;
    }
    if (event.name === "blockwright.crash" && !this.#crash) {
      // Agent events carry the emitter's own payload under data.data, beside its thread and role.
      const envelope = (event.data ?? {}) as { data?: unknown; thread?: unknown };
      const data = (isRecord(envelope.data) ? envelope.data : envelope) as {
        exceptionClass?: unknown; message?: unknown; thread?: unknown;
      };
      const thread = data.thread ?? envelope.thread ?? "?";
      this.#crash = `crash [${String(thread)}] ${String(data.exceptionClass ?? "?")}: ${String(data.message ?? "")}`;
    }
  }

  summarize(): string[] {
    const details: string[] = [];
    if (this.#crash) {
      details.push(this.#crash);
    }
    details.push(...this.#evidence);
    details.push(...this.#fatalLines);
    if (details.length === 0) {
      details.push("no recognizable fatal line in the process output; see the trace file for the full log");
    }
    return details;
  }
}

/** The crash report and JVM fatal-error log the driver found beside a dead game, with their key lines. */
function crashEvidence(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const lines: string[] = [];
  const add = (label: string, path: unknown, summary: unknown) => {
    if (typeof path !== "string") return;
    lines.push(`${label}: ${path}`);
    if (Array.isArray(summary)) lines.push(...summary.filter((line): line is string => typeof line === "string").map((line) => `  ${line}`));
  };
  add("crash report", data.crashReport, data.crashSummary);
  add("JVM crash log", data.jvmCrashLog, data.jvmCrashSummary);
  return lines;
}

/** The agent's single readiness event: a server whose world has ticked, a client in a loaded level. */
export const READY_EVENT = "blockwright.lifecycle.ready";
/** Driver events that start a fresh game process; readiness before the latest one is stale. */
export const PROCESS_START_EVENTS = new Set(["process.spawn", "process.restart"]);

function isProcessOutput(event: TraceEvent): boolean {
  return event.name === "process.stdout" || event.name === "process.stderr";
}

/**
 * One instance's trace file, read incrementally and shared by all of its waits. Lifecycle and agent
 * events are kept (bounded) so a wait started late still sees them; process output lines only feed
 * the death diagnostics and the wait that polled them.
 */
export class TraceLog {
  static readonly MAX_EVENTS = 10_000;

  readonly diagnostics = new InstanceDeathDiagnostics();
  readonly #events: TraceEvent[] = [];
  #dropped = 0;
  #offset = 0;

  constructor(readonly path: string) {}

  /** Reads what was appended since the last poll and returns its process output events. */
  poll(): TraceEvent[] {
    const output: TraceEvent[] = [];
    for (const line of this.#readCompleteLines()) {
      let event: TraceEvent;
      try {
        event = JSON.parse(line) as TraceEvent;
      } catch {
        continue;
      }
      this.diagnostics.observe(event);
      if (isProcessOutput(event)) {
        output.push(event);
        continue;
      }
      this.#events.push(event);
      if (this.#events.length > TraceLog.MAX_EVENTS) {
        this.#events.shift();
        this.#dropped++;
      }
    }
    return output;
  }

  #readCompleteLines(): string[] {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return [];
    }
    try {
      const length = fstatSync(fd).size - this.#offset;
      if (length <= 0) return [];
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const n = readSync(fd, buffer, filled, length - filled, this.#offset + filled);
        if (n === 0) break;
        filled += n;
      }
      const lastNewline = buffer.lastIndexOf(0x0a, filled - 1);
      if (lastNewline === -1) return [];
      this.#offset += lastNewline + 1;
      return buffer.subarray(0, lastNewline).toString("utf8").split(/\r?\n/).filter((line) => line.startsWith("{"));
    } finally {
      closeSync(fd);
    }
  }

  /** Why the game process started last is gone, or undefined while it runs. */
  terminal(): string | undefined {
    const start = this.lastPosition((event) => PROCESS_START_EVENTS.has(event.name));
    for (const event of this.since(start).events) {
      const reason = terminalReason(event);
      if (reason) return reason;
    }
    return undefined;
  }

  /** Position of the newest kept event `accept` matches, or 0 when none does. */
  lastPosition(accept: (event: TraceEvent) => boolean): number {
    for (let index = this.#events.length - 1; index >= 0; index--) {
      if (accept(this.#events[index])) return this.#dropped + index;
    }
    return 0;
  }

  /** Kept events from position `from` on, and the position to continue from next time. */
  since(from: number): { events: TraceEvent[]; next: number } {
    return {
      events: this.#events.slice(Math.max(0, from - this.#dropped)),
      next: this.#dropped + this.#events.length,
    };
  }
}
