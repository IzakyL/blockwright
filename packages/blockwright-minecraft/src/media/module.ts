import { CORE_CLIENT, defineModule } from "../core/index.js";
import { moduleTasks } from "../core/templates.js";

/** Screenshots, frame recording, draw and sound capture. Client-only: it names client and GL classes. */
export const MEDIA = defineModule("blockwright.minecraft.media", { requires: [CORE_CLIENT], roles: ["client"] });

/** Media templates: one call into the media module (see core/templates.ts). */
export const mediaTask = moduleTasks(MEDIA);
