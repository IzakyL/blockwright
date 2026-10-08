import type { TaskLimits, TaskThread } from "@izakyl/blockwright-client";
import type { PrefabModule } from "./modules.js";

/** Which instances a template runs on: a server, a client, or either (it then runs on that side's thread). */
export type TaskSide = "server" | "client" | "any";

/** How a client settles before a task runs; see {@link SettleOptions}. */
export interface TemplateSettle {
  /** Also wait until no screen is open (for actions through the player, which a screen would swallow). */
  requireNoScreen?: boolean;
}

/**
 * A task template: Java source plus what it needs and how to read its answer. Declare templates as
 * module-level constants with {@link defineTask}; run them with a handle's `run`.
 *
 * The source is a complete `Task` class (build it with {@link javaTask}); it reads its arguments from
 * `ctx.args()` (usually `Args.of(ctx)`), and its answer is its last JSON output. Keep logic in module classes
 * under `java/` (gradle compile-checks those) and templates to a few lines calling them.
 */
export interface TaskTemplate<A = unknown, R = unknown> {
  /** Names the operation in errors, e.g. `world.block`. */
  readonly name: string;
  readonly side: TaskSide;
  /** Where `run` is invoked; default the side's own thread (`server` on a server, `client` on a client). */
  readonly thread?: TaskThread;
  /** Modules the source references beyond the core ones (their requirements are implied). */
  readonly modules?: readonly PrefabModule[];
  readonly source: string;
  /** Turns the answer (with any sync stamp removed) into R; default: the answer as it is. */
  readonly parse?: (value: unknown, args: A) => R;
  /** The agent's deadline for the run; default the agent's (15 s). 0 = none. */
  readonly timeoutMs?: number;
  readonly limits?: TaskLimits;
  /**
   * Client templates only: how the client settles to the server's pending sync marks before the task
   * runs. Default `{}` (epoch plus one frame); `false` skips it (for tasks that must not wait, such as the
   * settle itself, raw frame capture or input that is itself racing the server).
   */
  readonly settle?: false | TemplateSettle;
  /** The answer must be a JSON output (default true); false allows a task that emits nothing (R = undefined). */
  readonly requiresOutput?: boolean;
}

export function defineTask<A = void, R = unknown>(template: TaskTemplate<A, R>): TaskTemplate<A, R> {
  if (!template.name) throw new TypeError("a task template needs a name");
  if (!/public\s+final\s+class\s+Task\b/.test(template.source)) {
    throw new TypeError(`task template ${template.name}: the source must declare public final class Task`);
  }
  return template;
}

/** Imports every generated task gets. */
export const TASK_IMPORTS: readonly string[] = [
  "dev.blockwright.api.*",
  "blockwright.minecraft.core.*",
  "java.util.*",
  "java.util.concurrent.*",
];

export interface JavaTaskParts {
  /** Extra imports: class names or `pkg.*`, without `import` and `;`. */
  imports?: readonly string[];
  /** The body of `public static Object run(Context ctx) throws Exception`. */
  body: string;
  /** Extra members of the Task class (helper methods, nested classes). */
  members?: string;
}

/** A complete task source: the standard imports, then `run(ctx)` with `body`. */
export function javaTask(parts: JavaTaskParts): string {
  const imports = [...TASK_IMPORTS, ...(parts.imports ?? [])].map((name) => `import ${name};`).join("\n");
  return `${imports}

public final class Task {
    public static Object run(Context ctx) throws Exception {
${indent(parts.body.trim(), 8)}
    }
${parts.members ? `\n${indent(parts.members.trim(), 4)}\n` : ""}}
`;
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text.split("\n").map((line) => (line.length > 0 ? pad + line : line)).join("\n");
}
