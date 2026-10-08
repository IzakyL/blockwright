export type InstanceRole = "server" | "client";

export interface InstanceLaunchOptions {
  config?: string;
  instance?: string;
  /** Trace file path; the driver picks one under the instance dir when omitted. */
  trace?: string;
  agentMod?: string;
  /** Servers start with ticks frozen before their first tick (default true); restarts keep it. */
  startFrozen?: boolean;
  /** Launch into the instance dir as it is (files seeded into it) instead of clearing it; it still goes away on close. */
  reuseInstanceDir?: boolean;
  /** Reuse the instance dir and keep it past close and `blockwright gc`. */
  keepInstanceDir?: boolean;
}

/** What the driver's `neoforge.launch` answers. */
export interface InstanceLaunchResult {
  instanceId: string;
  role: InstanceRole;
  tracePath: string;
  instanceDir: string;
}

export interface InstanceCloseOptions {
  /** Leave the instance dir in place instead of deleting it (`blockwright gc` may still reclaim it later). */
  keepInstanceDir?: boolean;
  /** How long the game gets after SIGTERM (shutdown hooks run) before the driver SIGKILLs it; default 10000. */
  graceMs?: number;
}

/**
 * What the driver's `lifecycle.close` answers: how the process ended and, when the game left a crash report
 * or JVM fatal-error log behind during this run, where it is and what it says (the same data as the trace's
 * `process.exit` event).
 */
export interface InstanceCloseResult {
  /** The exit code; null when a signal ended the process or there was none. */
  code: number | null;
  /** The signal that ended the process, when one did (e.g. 15 SIGTERM, 9 SIGKILL). */
  signal?: number | null;
  /**
   * The process exited on its own: its exit status succeeded. The driver stopped it: it went on SIGTERM
   * (exit 0 or 143, or the signal) without leaving crash evidence.
   */
  success: boolean;
  /** The driver stopped the process (SIGTERM, then SIGKILL after the grace period); false when it had already exited on its own. */
  terminated?: boolean;
  /** It outlived SIGTERM's grace period and was SIGKILLed. */
  killed?: boolean;
  crashReport?: string;
  /** `Description:` and the exception with its first frames. */
  crashSummary?: string[];
  jvmCrashLog?: string;
  /** The HotSpot header: signal and problematic frame. */
  jvmCrashSummary?: string[];
}
