import type { BlockwrightInstance } from "@izakyl/blockwright-client";

/**
 * What the prefab needs from an instance. A {@link BlockwrightInstance} is one; tests pass a fake. The
 * directory and trace are where failure evidence reads how the process ended and what it logged.
 */
export type GameInstance = Pick<BlockwrightInstance,
  "instanceId" | "role" | "run" | "ensureModules" | "instanceDir" | "tracePath">;
