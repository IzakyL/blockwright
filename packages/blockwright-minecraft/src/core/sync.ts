import type { GameInstance } from "./instance.js";

/** A server's epoch after a mutating task: a client that received it has every update sent before it. */
export interface SyncMark {
  serverId: string;
  epoch: number;
}

/** The key a stamped answer (`Sync.stamp` in Java) carries its mark under; the value sits under `value`. */
export const SYNC_KEY = "$sync";

/**
 * The newest mark of every server, and how far each client has settled. One ledger serves the whole process
 * (marks are keyed by server id, and a client skips marks of servers it is not connected to), so handles
 * built separately for a server and its client share it without wiring.
 */
export class SyncLedger {
  readonly #marks = new Map<string, number>();
  readonly #settled = new WeakMap<GameInstance, Map<string, number>>();

  record(mark: SyncMark): void {
    this.#marks.set(mark.serverId, Math.max(this.#marks.get(mark.serverId) ?? 0, mark.epoch));
  }

  /** Marks `client` has not settled to yet. */
  pending(client: GameInstance): SyncMark[] {
    const settled = this.#settled.get(client);
    const pending: SyncMark[] = [];
    for (const [serverId, epoch] of this.#marks) {
      if ((settled?.get(serverId) ?? 0) < epoch) pending.push({ serverId, epoch });
    }
    return pending;
  }

  /** Records that `client` settled to `marks`. */
  settled(client: GameInstance, marks: readonly SyncMark[]): void {
    let settled = this.#settled.get(client);
    if (!settled) this.#settled.set(client, (settled = new Map()));
    for (const mark of marks) settled.set(mark.serverId, Math.max(settled.get(mark.serverId) ?? 0, mark.epoch));
  }

  /** The newest mark of every server. */
  marks(): SyncMark[] {
    return [...this.#marks].map(([serverId, epoch]) => ({ serverId, epoch }));
  }
}

export const defaultSyncLedger = new SyncLedger();

/** Splits a stamped answer into its value and mark; an unstamped answer passes through. */
export function unstamp(answer: unknown): { value: unknown; mark?: SyncMark } {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer) || !(SYNC_KEY in answer)) {
    return { value: answer };
  }
  const record = answer as Record<string, unknown>;
  const mark = record[SYNC_KEY] as Partial<SyncMark> | undefined;
  const valid = typeof mark?.serverId === "string" && typeof mark.epoch === "number";
  return { value: record.value, ...(valid ? { mark: { serverId: mark.serverId!, epoch: mark.epoch! } } : {}) };
}

/** How a client settles; see Settle.java. */
export interface SettleOptions {
  /** Also do a barrier round trip through the server (covers updates no mark announced). */
  barrier?: boolean;
  /** Frames to render after the epoch arrived; default 1. */
  frames?: number;
  /** Wait until no screen is open. */
  requireNoScreen?: boolean;
  /** Default 5000. */
  timeoutMs?: number;
}

export interface SettleResult {
  serverId: string | null;
  /** The client's received epoch afterwards (-1 when its server never announced one). */
  epoch: number;
  frames: number;
  elapsedMs: number;
  /** The marks it settled to. */
  marks: SyncMark[];
}
