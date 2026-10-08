/** One line of an instance's trace file. */
export interface TraceEvent {
  ts: string;
  seq: number;
  instance_id: string;
  category: string;
  name: string;
  data: unknown;
}

/** A wait on an instance's trace. */
export interface WaitOptions {
  /** How long to wait; the default depends on the wait. */
  timeoutMs?: number;
  /** How often to read the trace. Default 250 (200 for `waitForExit`). */
  pollMs?: number;
}

export interface WaitForReadyOptions extends WaitOptions {
  /** Default 120000. */
  timeoutMs?: number;
  /**
   * A client only: fail once its output has been silent this long right after "Connecting to …" (the
   * server never answered the login). Default 90000.
   */
  connectStallMs?: number;
}

/** A request to the driver or the game agent. */
export interface RequestOptions {
  /** How long to wait for the answer; null waits as long as the connection lives. The default depends on the request. */
  timeoutMs?: number | null;
}
