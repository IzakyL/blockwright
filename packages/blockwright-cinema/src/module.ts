import { fileURLToPath } from "node:url";
import { CORE, defineModule } from "@izakyl/blockwright-minecraft";

/** This package's Java (`java/` at the package root, shipped beside `dist/`). */
export const CINEMA_JAVA_ROOT = fileURLToPath(new URL("../java/", import.meta.url));

/** The cinema's Java: sight lines through the world as it stands. Names no client class. */
export const CINEMA = defineModule("blockwright.cinema", { requires: [CORE], root: CINEMA_JAVA_ROOT });
