import {
  BlockwrightConnectionClosedError,
  BlockwrightInstanceGoneError,
  BlockwrightRequestTimeoutError,
  errorSummary,
  errorToString,
} from "@izakyl/blockwright-client";
import { MinecraftTaskError } from "./core/errors.js";
import { MinecraftCommandError } from "./world/commands.js";

/** What {@link attempt} answers in place of a call the game refused or failed. */
export interface Refusal {
  status: "error";
  /** One line. */
  reason: string;
  /** The error in full, with its causes. */
  error: string;
}

export function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && (value as Refusal).status === "error"
    && typeof (value as Refusal).reason === "string" && typeof (value as Refusal).error === "string";
}

/** Whether `error` says the instance is gone or cannot be reached, which no later call will get past. */
export function instanceLost(error: unknown): boolean {
  return error instanceof BlockwrightInstanceGoneError
    || error instanceof BlockwrightConnectionClosedError
    || error instanceof BlockwrightRequestTimeoutError;
}

export interface AttemptOptions {
  /**
   * What counts as a refusal. `game` (default): what the game answered — a task that failed, a command that
   * did not take, a wait that ran out. `any`: every Error but a lost instance, for helpers built on the
   * prefab that refuse with a plain Error (a UI adapter's "not actionable").
   */
  refusals?: "game" | "any";
}

/**
 * Runs `fn` and answers its value, or a {@link Refusal} when the game refused or failed it: for steps whose
 * failure is evidence to record and judge later, not the end of the test. A lost instance, a dropped
 * connection and (unless `refusals: "any"`) a bug in the caller still throw.
 */
export async function attempt<T>(fn: () => Promise<T>, options: AttemptOptions = {}): Promise<T | Refusal> {
  try {
    return await fn();
  } catch (error) {
    const refused = options.refusals === "any"
      ? error instanceof Error && !instanceLost(error)
      : error instanceof MinecraftTaskError || error instanceof MinecraftCommandError;
    if (!refused) throw error;
    return { status: "error", reason: errorSummary(error), error: errorToString(error) };
  }
}
