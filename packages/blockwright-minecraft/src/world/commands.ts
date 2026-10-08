import type { CallOptions, MinecraftServer, RunTemplateOptions } from "../core/index.js";
import { defined } from "../core/templates.js";
import { worldTask } from "./module.js";
import type { CommandResult, ProbeVerdict } from "./types.js";

export interface WorldCommandOptions extends CallOptions {
  /** Answer the result even when a command did not succeed, instead of throwing {@link MinecraftCommandError}. */
  allowFailure?: boolean;
  /** With several commands: stop at the first that does not succeed (the rest are not run). */
  stopOnFailure?: boolean;
}

/** A command did not succeed; `result` says what the game answered. */
export class MinecraftCommandError extends Error {
  readonly command: string;
  readonly result: CommandResult;

  constructor(result: CommandResult, message?: string) {
    const said = result.output.length > 0 ? result.output.join(" | ") : result.invoked ? "it reported failure" : "no result";
    super(message ?? `command did not take effect: /${result.command} -> ${said}`);
    this.name = "MinecraftCommandError";
    this.command = result.command;
    this.result = result;
  }
}

const COMMANDS = worldTask<{ commands: string[]; stopOnFailure?: boolean }, CommandResult[]>("world.command", "Commands.execute");
const PROBE = worldTask<{ command: string }, ProbeVerdict>("world.probe", "Commands.probe");

function runOptions(options: CallOptions): RunTemplateOptions {
  return defined({ signal: options.signal, timeoutMs: options.timeoutMs });
}

/**
 * Runs a command as the server console (permission 4, at the world spawn) and answers what it said; given
 * several, runs them in order in one task (one tick, one round trip) and answers each. Throws
 * {@link MinecraftCommandError} for the first that did not succeed unless `allowFailure`; all of them run
 * unless `stopOnFailure`. The answer is stamped, so a client task that runs next settles to the effects first.
 */
export function worldCommand(server: MinecraftServer, command: string, options?: WorldCommandOptions): Promise<CommandResult>;
export function worldCommand(server: MinecraftServer, commands: readonly string[], options?: WorldCommandOptions): Promise<CommandResult[]>;
export async function worldCommand(
  server: MinecraftServer,
  commands: string | readonly string[],
  options: WorldCommandOptions = {},
): Promise<CommandResult | CommandResult[]> {
  const list = typeof commands === "string" ? [commands] : [...commands];
  const results = list.length === 0 ? [] : await server.run(COMMANDS, {
    commands: list,
    ...(options.stopOnFailure ? { stopOnFailure: true } : {}),
  }, runOptions(options));
  const failed = results.find((result) => !result.success);
  if (failed && !options.allowFailure) throw new MinecraftCommandError(failed);
  return typeof commands === "string" ? results[0]! : results;
}

const PROBE_RUN_CLAUSE = "time query gametime";

/**
 * The command that tests an `execute` condition (`if block ~ ~ ~ stone`, `unless entity @e[type=pig]`, with
 * or without a leading `/execute`): `execute <condition> run time query gametime`. The run clause makes a
 * false condition (nothing runs, nothing said) distinguishable from one the game cannot evaluate (it says why).
 */
export function probeCommand(condition: string): string {
  let text = condition.trim();
  if (text.startsWith("/")) text = text.slice(1).trim();
  if (/^execute\b/.test(text)) text = text.replace(/^execute\b\s*/, "");
  if (text.length === 0) throw new TypeError("a probe condition must be a non-empty execute sub-command");
  if (/\brun\b/.test(text)) {
    throw new TypeError(`a probe condition must not carry its own 'run' clause (got: ${text}); ` +
      "the probe appends one so that a false condition stays distinguishable from an unevaluable one");
  }
  return `execute ${text} run ${PROBE_RUN_CLAUSE}`;
}


/**
 * Whether an `execute` condition holds now. Throws when the game cannot evaluate it (a misspelt NBT path, an
 * unknown selector or item id, an out-of-range coordinate) — that is not the same as false.
 */
export async function worldProbe(server: MinecraftServer, condition: string, options: CallOptions = {}): Promise<boolean> {
  const verdict = await server.run(PROBE, { command: probeCommand(condition) }, runOptions(options));
  if (verdict.verdict === "unevaluable") {
    throw new MinecraftCommandError(verdict, `probe could not be evaluated: /${verdict.command}\n` +
      `the game answered ${JSON.stringify(verdict.output)} instead of a result: a misspelt NBT path, an unknown ` +
      "selector or item id, or an out-of-range coordinate. This is NOT the same as the condition being false.");
  }
  return verdict.verdict === "true";
}
