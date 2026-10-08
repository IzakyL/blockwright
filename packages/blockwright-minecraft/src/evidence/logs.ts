import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading a game's logs outside the game: the instance's own `logs/latest.log` plus what the driver captured
 * from stdout and stderr (the trace file), merged and de-duplicated, and a scan for the usual trouble (mixin
 * failures, registry and datapack errors, exception groups). Crash reports are not read here: the driver
 * summarises them once (see `readCrashEvidence`).
 */

export const GAME_LOG_LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

export type GameLogLevel = (typeof GAME_LOG_LEVELS)[number];

/** `game`: logs/latest.log; `trace`: the driver's capture of stdout/stderr and exits; `both` merges them. */
export type GameLogSource = "game" | "trace" | "both";

/** Where an instance's logs are. */
export interface GameLogTarget {
  instanceDir?: string;
  tracePath?: string;
}

export interface GameLogEntry {
  /** Epoch milliseconds, when the line said. */
  at?: number;
  level: string;
  thread: string;
  logger: string;
  message: string;
  /** Continuation lines (stack frames). */
  extra: string[];
  /** `log`, `stdout`, `stderr` or `driver`. */
  origin: string;
  raw: string;
}

export interface GameLogFilter {
  /** Epoch milliseconds; entries without a time are kept. */
  since?: number;
  /** At least this level. */
  level?: GameLogLevel;
  /** Matched against the message and its continuation lines. */
  grep?: RegExp;
}

export interface GameLogException {
  /** `class: message`. */
  key: string;
  count: number;
  firstAt?: number;
  /** The first stack frame. */
  frame?: string;
}

export interface GameLogAnalysis {
  mixin: string[];
  registry: string[];
  datapack: string[];
  /** Distinct throwables, in the order first seen. */
  exceptions: GameLogException[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const HEADER = /^\[(\d{2})([A-Za-z]{3})(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\] \[([^\]]*)\] \[([^\]]*)\]: ?(.*)$/;

const FRAME = /^\s+(?:at |\.\.\. )/;

const EXCEPTION = /(?:^|[\s:])((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable))(?::\s*(.*))?/;

const MIXIN = /(mixin apply failed|InjectionError|InvalidInjectionException|InvalidMixinException|Critical injection failure|MixinApplyError|MixinTransformerError|was not found in|@Inject.*could not find|Mixin config .* could not be)/i;

const REGISTRY = /(registry|registration)/i;

const REGISTRY_FAULT = /(missing|unknown|unregistered|duplicate|failed|not present|frozen|non-registered|invalid)/i;

const DATAPACK = /(data ?pack|datapacks|resource ?pack|tag file|recipe|loot table|advancement|Couldn't parse|Couldn't load|Failed to load|Failed to reload|Failed to update|non \[a-z0-9)/i;

const DATAPACK_FAULT = /(couldn't|could not|failed|error|invalid|missing|unknown)/i;

/** Every entry of an instance's logs, oldest first. Unreadable files read as empty. */
export function readGameLog(target: GameLogTarget, options: { source?: GameLogSource } = {}): GameLogEntry[] {
  const source = options.source ?? "both";
  const entries: GameLogEntry[] = [];
  const seen = new Set<string>();
  if (source !== "trace" && target.instanceDir) {
    for (const entry of readLatestLog(target.instanceDir)) {
      seen.add(entry.raw);
      entries.push(entry);
    }
  }
  if (source !== "game" && target.tracePath) {
    for (const entry of readTraceOutput(target.tracePath)) {
      if (!seen.has(entry.raw)) entries.push(entry);
    }
  }
  entries.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
  return entries;
}

export function filterGameLog(entries: readonly GameLogEntry[], filter: GameLogFilter = {}): GameLogEntry[] {
  const minLevel = filter.level ? GAME_LOG_LEVELS.indexOf(filter.level) : -1;
  return entries.filter((entry) =>
    (filter.since === undefined || entry.at === undefined || entry.at >= filter.since)
    && (minLevel === -1 || levelIndex(entry.level) >= minLevel)
    && (filter.grep === undefined || filter.grep.test(entry.message) || entry.extra.some((line) => filter.grep!.test(line))));
}

function levelIndex(level: string): number {
  return GAME_LOG_LEVELS.indexOf(level as GameLogLevel);
}

function readLatestLog(instanceDir: string): GameLogEntry[] {
  const path = join(instanceDir, "logs", "latest.log");
  if (!existsSync(path)) return [];
  try {
    return parseLogLines(readFileSync(path, "utf8").split(/\r?\n/), "log");
  } catch {
    return [];
  }
}

function readTraceOutput(tracePath: string): GameLogEntry[] {
  let text: string;
  try {
    text = readFileSync(tracePath, "utf8");
  } catch {
    return [];
  }
  const entries: GameLogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("{") || !line.includes('"category":"process"')) continue;
    let event: { ts?: string; name?: string; data?: Record<string, unknown> };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = event.ts ? Date.parse(event.ts) : undefined;
    if (event.name === "process.stdout" || event.name === "process.stderr") {
      const raw = String(event.data?.line ?? "");
      const stderr = event.name === "process.stderr";
      // Only a line in the game's log pattern says its own level; other stderr output counts as a warning.
      const parsed = HEADER.test(raw) ? parseLogLines([raw], stderr ? "stderr" : "stdout") : [];
      if (parsed.length > 0) {
        entries.push({ ...parsed[0]!, at: parsed[0]!.at ?? at });
      } else if (raw.trim().length > 0) {
        entries.push({
          at, level: stderr ? "WARN" : "INFO", thread: "-", logger: stderr ? "stderr" : "stdout",
          message: raw, extra: [], origin: stderr ? "stderr" : "stdout", raw,
        });
      }
      continue;
    }
    if (event.name === "process.exit" || event.name === "process.died") {
      const raw = `${event.name} ${JSON.stringify(event.data ?? {})}`;
      entries.push({
        at, level: event.data?.success === false && event.name === "process.died" ? "ERROR" : "INFO",
        thread: "-", logger: "driver", message: raw, extra: [], origin: "driver", raw,
      });
    }
  }
  return entries;
}

/** Parses log4j lines of the game's pattern; lines without a header continue the previous entry. */
export function parseLogLines(lines: readonly string[], origin: string): GameLogEntry[] {
  const entries: GameLogEntry[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const match = HEADER.exec(line);
    if (!match) {
      const last = entries[entries.length - 1];
      if (last) {
        last.extra.push(line);
        last.raw += `\n${line}`;
      } else if (line.trim().length > 0) {
        entries.push({
          level: FRAME.test(line) ? "ERROR" : "INFO", thread: "-", logger: origin, message: line, extra: [], origin, raw: line,
        });
      }
      continue;
    }
    const [, day, month, year, hour, minute, second, millis, thread, logger, message] = match as unknown as string[];
    const slash = thread!.lastIndexOf("/");
    entries.push({
      at: new Date(Number(year), Math.max(0, MONTHS.indexOf(month!)), Number(day), Number(hour), Number(minute),
        Number(second), Number(millis)).getTime(),
      level: slash === -1 ? "INFO" : thread!.slice(slash + 1).toUpperCase(),
      thread: slash === -1 ? thread! : thread!.slice(0, slash),
      logger: logger!,
      message: message!,
      extra: [],
      origin,
      raw: line,
    });
  }
  return entries;
}

/** Picks out mixin failures, registry and datapack problems and groups exceptions. */
export function analyzeGameLog(entries: readonly GameLogEntry[]): GameLogAnalysis {
  const analysis: GameLogAnalysis = { mixin: [], registry: [], datapack: [], exceptions: [] };
  const throwables = new Map<string, GameLogException>();
  const warn = levelIndex("WARN");
  for (const entry of entries) {
    const body = [entry.message, ...entry.extra].join("\n");
    const bad = levelIndex(entry.level) >= warn;
    const line = `${logClock(entry.at, false)} ${entry.message}`;
    if (MIXIN.test(body)) analysis.mixin.push(line);
    if (bad && REGISTRY.test(body) && REGISTRY_FAULT.test(body)) analysis.registry.push(line);
    if (bad && DATAPACK.test(body) && DATAPACK_FAULT.test(body)) analysis.datapack.push(line);
    const thrown = EXCEPTION.exec(body);
    if (thrown && (bad || entry.extra.some((each) => FRAME.test(each)))) {
      const key = `${thrown[1]}${thrown[2] ? `: ${thrown[2].slice(0, 120)}` : ""}`;
      const seen = throwables.get(key);
      if (seen) {
        seen.count += 1;
      } else {
        const frame = entry.extra.find((each) => FRAME.test(each))?.trim();
        throwables.set(key, { key, count: 1, ...(entry.at !== undefined ? { firstAt: entry.at } : {}), ...(frame ? { frame } : {}) });
      }
    }
  }
  analysis.mixin = dedupe(analysis.mixin);
  analysis.registry = dedupe(analysis.registry);
  analysis.datapack = dedupe(analysis.datapack);
  analysis.exceptions = [...throwables.values()];
  return analysis;
}

/** The analysis as indented report lines; empty when nothing was found. */
export function formatGameLogAnalysis(analysis: GameLogAnalysis, limit = 8): string[] {
  const lines: string[] = [];
  listLines(lines, "mixin failures", analysis.mixin, limit);
  listLines(lines, "registry problems", analysis.registry, limit);
  listLines(lines, "datapack problems", analysis.datapack, limit);
  if (analysis.exceptions.length > 0) {
    lines.push(`exceptions (${analysis.exceptions.length} distinct):`);
    for (const info of analysis.exceptions.slice(0, limit)) {
      lines.push(`  ${info.key}${info.count > 1 ? ` x${info.count}` : ""} first at ${logClock(info.firstAt, false)}${info.frame ? ` ${info.frame}` : ""}`);
    }
    if (analysis.exceptions.length > limit) lines.push(`  … ${analysis.exceptions.length - limit} more distinct exceptions`);
  }
  return lines;
}

/** One entry as a line, with up to `stackLines` continuation lines. */
export function formatGameLogEntry(entry: GameLogEntry, stackLines = 6): string {
  const head = `${logClock(entry.at, true)} ${entry.level} [${shortLogger(entry.logger)}] ${entry.message}`;
  if (entry.extra.length === 0) return head;
  const kept = entry.extra.slice(0, stackLines).map((line) => `    ${line.trim()}`);
  if (entry.extra.length > stackLines) kept.push(`    … ${entry.extra.length - stackLines} more stack lines`);
  return [head, ...kept].join("\n  ");
}

/** A `since` for logs: an ISO timestamp or a window back from now (`30s`, `5m`, `1h`, `500ms`). */
export function parseLogSince(since: string | undefined, now = Date.now()): number | undefined {
  if (since === undefined) return undefined;
  const relative = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(since.trim());
  if (relative) {
    const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[relative[2] as "ms" | "s" | "m" | "h"];
    return now - Number(relative[1]) * scale;
  }
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) throw new Error(`cannot read since=${JSON.stringify(since)}; use an ISO timestamp or a window like 5m`);
  return parsed;
}

/** `label (n):` and up to `limit` indented entries (then `… n more`); nothing for no entries. */
export function listLines(lines: string[], label: string, entries: readonly string[], limit: number): void {
  if (entries.length === 0) return;
  lines.push(`${label} (${entries.length}):`);
  for (const entry of entries.slice(0, limit)) lines.push(`  ${entry}`);
  if (entries.length > limit) lines.push(`  … ${entries.length - limit} more`);
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = line.slice(line.indexOf(" ") + 1);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shortLogger(logger: string): string {
  const name = logger.split("/")[0]!;
  const index = name.lastIndexOf(".");
  return index === -1 ? name : name.slice(index + 1);
}

function logClock(at: number | undefined, millis: boolean): string {
  if (at === undefined) return "--:--:--";
  const when = new Date(at);
  const parts = [when.getHours(), when.getMinutes(), when.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
  return millis ? `${parts}.${String(when.getMilliseconds()).padStart(3, "0")}` : parts;
}
