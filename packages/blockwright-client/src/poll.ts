import { delay } from "./instance-helpers.js";

export interface PollOptions {
  label?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export interface PollResult<T> {
  matched: boolean;
  value?: T;
  elapsedMs: number;
}

/**
 * Samples `witness` on the wall clock until it returns something other than undefined or the timeout
 * passes; never throws on timeout. An error thrown by the witness propagates.
 */
export async function poll<T>(
  witness: () => T | undefined | Promise<T | undefined>,
  options: PollOptions = {},
): Promise<PollResult<T>> {
  const label = options.label ?? "poll";
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(`poll(${label}) timeoutMs must be a non-negative number`);
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`poll(${label}) pollMs must be a positive number`);
  }
  const started = Date.now();
  for (;;) {
    const value = await witness();
    if (value !== undefined) return { matched: true, value, elapsedMs: Date.now() - started };
    const elapsedMs = Date.now() - started;
    if (elapsedMs >= timeoutMs) return { matched: false, elapsedMs };
    await delay(Math.min(pollMs, timeoutMs - elapsedMs));
  }
}
