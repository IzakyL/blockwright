import { CORE_CLIENT, defineModule } from "../core/index.js";
import { moduleTasks } from "../core/templates.js";

/** The client area's Java: input, interaction, camera, client state, vanilla screens, observe. Client-only. */
export const CLIENT = defineModule("blockwright.minecraft.client", { requires: [CORE_CLIENT], roles: ["client"] });

/**
 * Client templates: one call into the client module (see core/templates.ts). `settle` follows the sync
 * policy: default `{}` (epoch plus a frame when the server has pending marks); `{requireNoScreen: true}` for
 * actions through the player that a screen would swallow.
 */
export const clientTask = moduleTasks(CLIENT);
