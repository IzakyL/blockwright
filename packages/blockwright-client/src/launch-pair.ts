import { BlockwrightDriver, type DriverOptions } from "./driver.js";
import { traceLogOf, type BlockwrightInstance } from "./instance.js";
import { closeQuietly } from "./lifecycle.js";
import { PROCESS_START_EVENTS } from "./instance-helpers.js";
import { retry, type RetryPolicy } from "./retry.js";
import type { InstanceCloseResult, InstanceLaunchOptions } from "./types-launch.js";

/** The instances a failed launch attempt got as far as starting; either may already be dead. */
export interface LaunchAttemptFailure {
  error: unknown;
  /** 1-based. */
  attempt: number;
  server?: BlockwrightInstance;
  client?: BlockwrightInstance;
}

export interface LaunchPairOptions extends DriverOptions {
  /**
   * Drive this driver; otherwise one is started (from the {@link DriverOptions} here) and closed with the
   * pair.
   */
  driver?: BlockwrightDriver;
  /** Config for both instances unless their own options name one. */
  config?: string;
  server?: InstanceLaunchOptions;
  client?: InstanceLaunchOptions;
  /** How long each instance may take to become ready; default 240000 for the server, 300000 for the client. */
  readyTimeoutMs?: { server?: number; client?: number };
  /**
   * Launch the pair again when an attempt fails in a way the policy accepts (see {@link RetryPolicy});
   * a failed attempt's instances are closed before the next attempt starts, and the policy learns whether
   * one of them crashed (`context.crashed`). Default: one attempt. The front ends use {@link crashAwareRetry}.
   */
  retry?: RetryPolicy;
  /**
   * Collects evidence from a failed attempt while its instances still exist, before they are closed.
   * It runs for every failed attempt, retried or not; what it throws is ignored.
   */
  onLaunchFailure?(failure: LaunchAttemptFailure): Promise<void> | void;
  /**
   * Runs right before each instance is closed at teardown (client first, then server), for example to
   * stop it gracefully. It also runs for the instances of a failed attempt. What it throws is ignored.
   */
  beforeClose?(instance: BlockwrightInstance): Promise<void> | void;
}

export interface InstancePair {
  driver: BlockwrightDriver;
  server: BlockwrightInstance;
  client: BlockwrightInstance;
  /** The failures of attempts that `retry` replaced, oldest first; empty when the first one held. */
  retried: unknown[];
  /**
   * Ordered teardown: the client closes, then the server, then the driver if `launchPair` started
   * it. Answers how each process ended (absent when an instance close failed). Driver shutdown failures
   * reject after cleanup; a second call answers the same result or failure.
   */
  close(): Promise<PairCloseResult>;
}

/** The driver's close result per instance of a pair. */
export interface PairCloseResult {
  server?: InstanceCloseResult;
  client?: InstanceCloseResult;
}

const DEFAULT_SERVER_READY_TIMEOUT_MS = 240_000;
const DEFAULT_CLIENT_READY_TIMEOUT_MS = 300_000;

/**
 * Launches a server, then a client, and waits for both to be ready — the one launch path the front
 * ends share. The server starts first; readiness is awaited for both together.
 */
export async function launchPair(options: LaunchPairOptions = {}): Promise<InstancePair> {
  const owned = options.driver === undefined;
  const driver = options.driver ?? new BlockwrightDriver({
    driverPath: options.driverPath,
    driverArgs: options.driverArgs,
    cwd: options.cwd,
    requestTimeoutMs: options.requestTimeoutMs,
    closeTimeoutMs: options.closeTimeoutMs,
    game: options.game,
  });
  let pair: { server: BlockwrightInstance; client: BlockwrightInstance };
  let retried: unknown[];
  // A failed attempt closes its instances; the driver must outlive that for the next attempt.
  const release = driver.retain();
  const crashed = new Map<number, boolean>();
  try {
    ({ value: pair, retried } = await retry(
      (attempt) => launchOnce(driver, options, attempt, crashed),
      options.retry,
      (attempt) => ({ crashed: crashed.get(attempt) ?? false }),
    ));
  } catch (error) {
    if (owned) {
      try {
        await driver.closeAsync();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "game launch and driver shutdown both failed", { cause: error });
      }
    }
    throw error;
  } finally {
    release();
  }

  let closing: Promise<PairCloseResult> | undefined;
  return {
    driver,
    server: pair.server,
    client: pair.client,
    retried,
    close() {
      closing ??= (async () => {
        const [client, server] = await closeInOrder([pair.client, pair.server], options.beforeClose);
        if (owned) await driver.closeAsync();
        return { ...(server ? { server } : {}), ...(client ? { client } : {}) };
      })();
      return closing;
    },
  };
}

async function launchOnce(
  driver: BlockwrightDriver,
  options: LaunchPairOptions,
  attempt: number,
  crashed: Map<number, boolean>,
): Promise<{ server: BlockwrightInstance; client: BlockwrightInstance }> {
  const serverOptions: InstanceLaunchOptions = { ...options.server, config: options.server?.config ?? options.config };
  const clientOptions: InstanceLaunchOptions = { ...options.client, config: options.client?.config ?? options.config };
  const serverTimeout = options.readyTimeoutMs?.server ?? DEFAULT_SERVER_READY_TIMEOUT_MS;
  const clientTimeout = options.readyTimeoutMs?.client ?? DEFAULT_CLIENT_READY_TIMEOUT_MS;

  let server: BlockwrightInstance | undefined;
  let client: BlockwrightInstance | undefined;
  try {
    server = await driver.launchNeoForge("server", serverOptions);
    client = await driver.launchNeoForge("client", clientOptions);
    const results = await Promise.allSettled([
      server.waitForReady({ timeoutMs: serverTimeout }),
      client.waitForReady({ timeoutMs: clientTimeout }),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    return { server, client };
  } catch (error) {
    try {
      await options.onLaunchFailure?.({ error, attempt, server, client });
    } catch {
    }
    const closed = await closeInOrder([client, server], options.beforeClose);
    crashed.set(attempt, [client, server].some((instance, index) => instanceCrashed(instance, closed[index])));
    throw error;
  }
}

/**
 * Whether an instance's latest process crashed: the driver found a crash report or JVM crash log, the
 * process died on its own without success, or the agent reported an uncaught exception.
 */
function instanceCrashed(instance: BlockwrightInstance | undefined, closed: InstanceCloseResult | undefined): boolean {
  if (closed && (closed.crashReport !== undefined || closed.jvmCrashLog !== undefined)) return true;
  if (closed && closed.terminated === false && !closed.success) return true;
  if (!instance) return false;
  try {
    const log = traceLogOf(instance);
    log.poll();
    const start = log.lastPosition((event) => PROCESS_START_EVENTS.has(event.name));
    return log.since(start).events.some((event) => {
      const data = (event.data ?? {}) as { success?: unknown; crashReport?: unknown; jvmCrashLog?: unknown };
      if (event.name === "blockwright.crash") return true;
      if (event.name === "process.died") return data.success !== true;
      return event.name === "process.exit" && (typeof data.crashReport === "string" || typeof data.jvmCrashLog === "string");
    });
  } catch {
    return false;
  }
}

async function closeInOrder(
  instances: Array<BlockwrightInstance | undefined>,
  beforeClose: LaunchPairOptions["beforeClose"],
): Promise<Array<InstanceCloseResult | undefined>> {
  const results: Array<InstanceCloseResult | undefined> = [];
  for (const instance of instances) {
    if (!instance) {
      results.push(undefined);
      continue;
    }
    try {
      await beforeClose?.(instance);
    } catch {
    }
    results.push(await closeQuietly(instance));
  }
  return results;
}
