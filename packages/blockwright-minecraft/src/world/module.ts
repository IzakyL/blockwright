import { CORE, defineModule } from "../core/index.js";
import { moduleTasks } from "../core/templates.js";

/** The world area's Java (`java/blockwright/minecraft/world/`): queries, commands, ticks, world waits. Servers only in practice, but it names no client class. */
export const WORLD = defineModule("blockwright.minecraft.world", { requires: [CORE] });

/** World templates: one call into the world module on the server (see core/templates.ts). */
export const worldTask = moduleTasks(WORLD);
