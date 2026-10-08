import { join } from "node:path";
import { z } from "zod";
import type { InstanceRole } from "@izakyl/blockwright-client";
import { evidence } from "@izakyl/blockwright-minecraft";
import { parseLogSince } from "@izakyl/blockwright-minecraft/internal";
import { roleArg } from "./schema.js";
import type { Args } from "./schema.js";

export interface LogTarget {
  role: InstanceRole;
  instanceId: string;
  instanceDir?: string;
  tracePath?: string;
}

export const logsShape = {
  role: roleArg,
  instance: z.string().optional(),
  since: z.string().optional(),
  level: z.enum(evidence.LOG_LEVELS as unknown as [evidence.LogLevel, ...evidence.LogLevel[]]).optional(),
  grep: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  source: z.enum(["game", "trace", "both"]).optional(),
  analyze: z.boolean().optional(),
  stack: z.number().int().min(0).max(60).optional(),
};

export type LogsRequest = Args<typeof logsShape>;

const DEFAULT_LIMIT = 60;

const DEFAULT_STACK = 6;

/**
 * The logs of each target, filtered, with the shared log analysis and the driver's crash summary (from the
 * trace's process.died / process.exit events, summarised once in Rust).
 */
export function readLogs(targets: LogTarget[], request: LogsRequest = {}): string {
  if (targets.length === 0) return "no instance to read logs from; launch one, or name it with `instance`";
  const since = parseLogSince(request.since);
  const grep = request.grep === undefined ? undefined : new RegExp(request.grep, "i");
  const limit = request.limit ?? DEFAULT_LIMIT;
  const source = request.source ?? "both";
  const sections: string[] = [];

  for (const target of targets) {
    const entries = evidence.readLog(target, { source });
    const windowed = evidence.filterLog(entries, { ...(since !== undefined ? { since } : {}) });
    const matched = evidence.filterLog(windowed, { ...(request.level ? { level: request.level } : {}), ...(grep ? { grep } : {}) });
    const filters = [
      `source ${source}`,
      request.since ? `since ${request.since}` : "",
      request.level ? `level>=${request.level}` : "",
      request.grep ? `grep ${JSON.stringify(request.grep)}` : "",
    ].filter((part) => part.length > 0).join(", ");
    const lines = [`logs: ${target.instanceId} (${target.role}) — ${matched.length} of ${windowed.length} entries — ${filters}`];
    if (entries.length === 0) {
      lines.push(`  no readable log at ${target.instanceDir ? join(target.instanceDir, "logs") : "(unknown instance dir)"}`);
    }
    if (matched.length > limit) lines.push(`  … ${matched.length - limit} older matching entries hidden; raise limit or narrow since/level/grep`);
    for (const entry of matched.slice(-limit)) lines.push(`  ${evidence.formatLogEntry(entry, request.stack ?? DEFAULT_STACK)}`);
    if (request.analyze ?? true) lines.push(...evidence.formatLogAnalysis(evidence.analyzeLog(windowed)));
    const crash = evidence.formatCrash(evidence.readCrash(target.tracePath));
    if (crash.length > 0) lines.push("process:", ...crash.map((line) => `  ${line}`));
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}
