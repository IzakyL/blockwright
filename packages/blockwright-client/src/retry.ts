import { errorSummary } from "./errors.js";

/**
 * Which failures deserve another attempt is the caller's call: blockwright cannot tell an upstream
 * hiccup (a mod racing its own classloader, a download the proxy cut short) from a real bug, and
 * a retry that guesses wrong hides the bug. So the caller names both the budget and the failures.
 */
export interface RetryPolicy {
  /** Attempts in total, the first one included. */
  attempts: number;
  /**
   * Whether the failure of attempt `attempt` (1-based) is worth another attempt. `context` is what the
   * operation learned about the failure (`launchPair`: whether the game crashed).
   */
  when(error: unknown, attempt: number, context?: RetryContext): boolean;
  /** Called before each further attempt, with the failure it replaces. */
  onRetry?(error: unknown, attempt: number): void | Promise<void>;
}

/** What an operation learned about a failed attempt, for {@link RetryPolicy.when}. */
export interface RetryContext {
  /** `launchPair`: a game process of the attempt crashed (crash report, JVM crash log, agent crash, or it died failing). */
  crashed?: boolean;
}

/**
 * The launch policy both front ends use: up to `attempts` attempts (default 2), retrying any failure except
 * a crash, which is a bug that another attempt only repeats; anything else may be a hiccup.
 */
export function crashAwareRetry(attempts = 2): RetryPolicy {
  return { attempts, when: (_error, _attempt, context) => context?.crashed !== true };
}

/** What {@link retry} returns: the value, and every failure a later attempt replaced. */
export interface Retried<T> {
  value: T;
  retried: unknown[];
}

/**
 * Runs `operation` until it succeeds, the policy declines a failure, or the attempts run out; the
 * last failure is thrown as is. Without a policy this is one plain call.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy | undefined,
  context?: (attempt: number) => RetryContext,
): Promise<Retried<T>> {
  const attempts = Math.max(1, Math.floor(policy?.attempts ?? 1));
  const retried: unknown[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await operation(attempt), retried };
    } catch (error) {
      if (!policy || attempt >= attempts || !policy.when(error, attempt, context?.(attempt))) {
        throw error;
      }
      retried.push(error);
      console.warn(`[blockwright] attempt ${attempt} of ${attempts} failed and will be retried: ${errorSummary(error)}`);
      await policy.onRetry?.(error, attempt);
    }
  }
}
