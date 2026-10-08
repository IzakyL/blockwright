import { readFileSync } from "node:fs";
import type { InstanceCloseResult } from "@izakyl/blockwright-client";

/**
 * How the latest game process of an instance ended, as the driver saw it. The driver (Rust) summarises crash
 * reports and JVM fatal-error logs once, into its `process.died` (the game exited on its own) and
 * `process.exit` (it was stopped; also the `lifecycle.close` answer) trace events; this reads them back.
 * The agent's own `blockwright.crash` events (an uncaught exception on a game thread) are added.
 */
export interface CrashEvidence {
  /** Set once the latest process ended. */
  ended?: {
    event: "process.died" | "process.exit";
    at: string;
    code: number | null;
    signal?: number | null;
    success: boolean;
    /** `process.exit` only: the driver stopped the process (false: it had exited on its own before the close). */
    terminated?: boolean;
    /** `process.exit` only: it ignored SIGTERM and was SIGKILLed. */
    killed?: boolean;
  };
  crashReport?: string;
  /** `Description:` and the exception with its first frames. */
  crashSummary?: string[];
  jvmCrashLog?: string;
  /** The HotSpot header: signal and problematic frame. */
  jvmCrashSummary?: string[];
  /** Uncaught exceptions the agent reported (`[thread] class: message`), oldest first. */
  agentCrashes: string[];
}

const WANTED = /"name":"(process\.(?:spawn|restart|died|exit)|blockwright\.crash)"/;

/** Reads an instance's trace file for its latest process's end and crash evidence; unreadable reads as nothing. */
export function readCrashEvidence(tracePath: string | undefined): CrashEvidence {
  const evidence: CrashEvidence = { agentCrashes: [] };
  if (!tracePath) return evidence;
  let text: string;
  try {
    text = readFileSync(tracePath, "utf8");
  } catch {
    return evidence;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("{") || !WANTED.test(line)) continue;
    let event: { ts?: string; name?: string; data?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    applyTraceEvent(evidence, event);
  }
  return evidence;
}

/** Folds one trace event into `evidence` (a new process start clears what the previous one left). */
export function applyTraceEvent(evidence: CrashEvidence, event: { ts?: string; name?: string; data?: unknown }): void {
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.name) {
    case "process.spawn":
    case "process.restart":
      for (const key of ["ended", "crashReport", "crashSummary", "jvmCrashLog", "jvmCrashSummary"] as const) delete evidence[key];
      evidence.agentCrashes = [];
      return;
    case "process.died":
    case "process.exit":
      // A process that died is not stopped again: the close after it adds nothing new.
      if (evidence.ended?.event === "process.died" && event.name === "process.exit") return;
      evidence.ended = {
        event: event.name,
        at: event.ts ?? "",
        code: typeof data.code === "number" ? data.code : null,
        ...(data.signal !== undefined ? { signal: typeof data.signal === "number" ? data.signal : null } : {}),
        success: data.success === true,
        ...(typeof data.terminated === "boolean" ? { terminated: data.terminated } : {}),
        ...(typeof data.killed === "boolean" ? { killed: data.killed } : {}),
      };
      if (typeof data.crashReport === "string") {
        evidence.crashReport = data.crashReport;
        evidence.crashSummary = strings(data.crashSummary);
      }
      if (typeof data.jvmCrashLog === "string") {
        evidence.jvmCrashLog = data.jvmCrashLog;
        evidence.jvmCrashSummary = strings(data.jvmCrashSummary);
      }
      return;
    case "blockwright.crash": {
      // Agent events carry the emitter's payload under data.data, beside its thread.
      const inner = (typeof data.data === "object" && data.data !== null ? data.data : data) as Record<string, unknown>;
      const thread = inner.thread ?? data.thread ?? "?";
      evidence.agentCrashes.push(`[${String(thread)}] ${String(inner.exceptionClass ?? "?")}: ${String(inner.message ?? "")}`);
      return;
    }
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [];
}

/**
 * The crash evidence in a close answer (`instance.close()`, `pair.close()`): the same data as the
 * `process.exit` event, without the trace's agent crashes.
 */
export function closeCrashEvidence(result: InstanceCloseResult): CrashEvidence {
  const evidence: CrashEvidence = { agentCrashes: [] };
  applyTraceEvent(evidence, { name: "process.exit", data: result });
  return evidence;
}

/** Whether the game left a crash behind (a report, a JVM fatal-error log, an agent crash, or it died failing). */
export function hasCrash(evidence: CrashEvidence): boolean {
  return evidence.crashReport !== undefined
    || evidence.jvmCrashLog !== undefined
    || evidence.agentCrashes.length > 0
    || (evidence.ended?.event === "process.died" && !evidence.ended.success);
}

/** Why the latest process is gone, or undefined while it runs. */
export function processEndReason(evidence: CrashEvidence): string | undefined {
  const ended = evidence.ended;
  if (!ended) return undefined;
  const how = ended.event === "process.died" || ended.terminated === false
    ? "exited on its own"
    : ended.killed ? "was killed after ignoring SIGTERM" : "was stopped";
  return `process ${how} (code=${ended.code ?? "null"}${ended.signal != null ? `, signal=${ended.signal}` : ""})`;
}

/** The evidence as report lines; empty when the process runs and nothing crashed. */
export function formatCrashEvidence(evidence: CrashEvidence): string[] {
  const lines: string[] = [];
  const reason = processEndReason(evidence);
  if (reason) lines.push(reason);
  for (const crash of evidence.agentCrashes.slice(-4)) lines.push(`agent crash ${crash}`);
  if (evidence.crashReport) {
    lines.push(`crash report: ${evidence.crashReport}`);
    for (const line of evidence.crashSummary ?? []) lines.push(`  ${line}`);
  }
  if (evidence.jvmCrashLog) {
    lines.push(`JVM crash log: ${evidence.jvmCrashLog}`);
    for (const line of evidence.jvmCrashSummary ?? []) lines.push(`  ${line}`);
  }
  return lines;
}
