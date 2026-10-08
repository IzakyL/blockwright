import { crashAwareRetry, errorSummary, launchPair } from "@izakyl/blockwright-client";
import type { InstancePair, LaunchAttemptFailure, LaunchPairOptions, PairCloseResult } from "@izakyl/blockwright-client";
import { minecraft, type MinecraftClient, type MinecraftServer } from "./core/binding.js";
import { captureLaunchFailureEvidence, formatFailureEvidence, type FailureEvidence } from "./evidence/capture.js";
import { stopGracefully } from "./world/lifecycle.js";

export interface LaunchGameOptions extends Omit<LaunchPairOptions, "beforeClose"> {
  /** Launch retry policy; default `crashAwareRetry()`: two attempts, and a crash is not retried. */
  retry?: LaunchPairOptions["retry"];
  /** Capture failure evidence of every failed attempt (default true). */
  launchEvidence?: boolean;
  /** Stop the server gracefully (saved, players disconnected) before it is closed; default true. */
  stopGracefully?: boolean;
  /** Replaces the client's `launchPair` (for tests of a front end). */
  launcher?: (options: LaunchPairOptions) => Promise<InstancePair>;
}

/** A launched server and client, bound to the prefab. */
export interface Game {
  server: MinecraftServer;
  client: MinecraftClient;
  /** The raw pair: instances, the driver, and the failures a retry replaced (`instances.retried`). */
  instances: InstancePair;
  /** Evidence of the attempts a retry replaced, oldest first. */
  launchFailures: FailureEvidence[];
  /** Closes the client, then the server (stopped gracefully unless turned off), then the driver it started. */
  close(): Promise<PairCloseResult>;
}

/** A launch that failed for good; `evidence` holds what each failed attempt left behind, oldest first. */
export class GameLaunchError extends Error {
  readonly evidence: FailureEvidence[];

  constructor(cause: unknown, evidence: FailureEvidence[]) {
    const report = evidence.map((each, index) => `--- attempt ${index + 1} ---\n${formatFailureEvidence(each)}`).join("\n\n");
    super(`the game did not launch after ${evidence.length || 1} attempt(s): ${errorSummary(cause)}${report ? `\n\n${report}` : ""}`,
      { cause });
    this.name = "GameLaunchError";
    this.evidence = evidence;
  }
}

/**
 * Launches a server and a client joined to it — the one launch path the front ends share: the retry policy,
 * failure evidence of every failed attempt, and a graceful server stop at close. A launch that fails for good
 * throws {@link GameLaunchError}.
 */
export async function launchGame(options: LaunchGameOptions = {}): Promise<Game> {
  const { launchEvidence = true, stopGracefully: graceful = true, launcher = launchPair, ...launch } = options;
  const launchFailures: FailureEvidence[] = [];
  let instances: InstancePair;
  try {
    instances = await launcher({
      ...launch,
      retry: launch.retry ?? crashAwareRetry(),
      async onLaunchFailure(failure: LaunchAttemptFailure) {
        if (launchEvidence) launchFailures.push(await captureLaunchFailureEvidence(failure));
        await launch.onLaunchFailure?.(failure);
      },
      ...(graceful ? { beforeClose: (instance) => stopGracefully(instance) } : {}),
    });
  } catch (error) {
    throw new GameLaunchError(error, launchFailures);
  }
  const { server, client } = minecraft(instances);
  return { server, client, instances, launchFailures, close: () => instances.close() };
}
