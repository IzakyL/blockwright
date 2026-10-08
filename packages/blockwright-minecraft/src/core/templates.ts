/**
 * How areas define their task templates (internal to the prefab: not re-exported from the barrels).
 *
 * One way: an area binds a factory to its module once (`const worldTask = moduleTasks(WORLD)`) and declares
 * each template as a module-level constant calling one entry point of that module:
 *
 * ```ts
 * const BLOCK = worldTask<{ pos: WorldPos }, BlockAtJson>("world.block", "WorldQueries.block");
 * const HUD = clientTask<void, HudText>("state.hudText", "return ClientState.hudText(ClientGame.mc(ctx));");
 * ```
 *
 * Templates that need more (a caller's Java, extra members) use {@link defineTask} with {@link javaTask}.
 */
import { CORE, CORE_CLIENT, type PrefabModule } from "./modules.js";
import { DEFAULT_WAIT_TIMEOUT_MS } from "./wait.js";
import { defineTask, javaTask, type TaskTemplate } from "./task.js";
import type { RunTemplateOptions } from "./binding.js";

export interface ModuleTaskOptions<A, R>
  extends Partial<Pick<TaskTemplate<A, R>, "side" | "thread" | "parse" | "timeoutMs" | "limits" | "settle" | "requiresOutput">> {
  /** Imports beyond the module's package, the core's and (client side) the client core's. */
  imports?: readonly string[];
  /** Extra members of the Task class. */
  members?: string;
  /** Modules the body references beyond the bound one. */
  modules?: readonly PrefabModule[];
}

export type ModuleTaskFactory = <A, R>(name: string, call: string, options?: ModuleTaskOptions<A, R>) => TaskTemplate<A, R>;

const ENTRY_POINT = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/;

/** The package every client-side template imports: `ClientGame`, `Settle`, `View`, `HeldKeys`. */
export const CORE_CLIENT_PACKAGE = "blockwright.minecraft.core.client";

/**
 * A template factory bound to `module`. `call` is either an entry point `Class.method` of the module, called
 * as `return Class.method(ctx, Args.of(ctx));`, or a complete `run` body. The task imports the module's
 * package (and, on the client side, {@link CORE_CLIENT_PACKAGE}); its side is `client` for a client-only
 * module and `server` otherwise unless `options.side` says so; it runs on the instance's own thread unless
 * `options.thread` says otherwise.
 */
export function moduleTasks(module: PrefabModule): ModuleTaskFactory {
  const clientOnly = module.roles.length === 1 && module.roles[0] === "client";
  return <A, R>(name: string, call: string, options: ModuleTaskOptions<A, R> = {}): TaskTemplate<A, R> => {
    const { imports, members, modules, side = clientOnly ? "client" : "server", ...rest } = options;
    const body = ENTRY_POINT.test(call.trim()) ? `return ${call.trim()}(ctx, Args.of(ctx));` : call;
    return defineTask<A, R>({
      name,
      side,
      modules: [module, ...(modules ?? [])],
      source: javaTask({
        imports: [`${module.name}.*`, ...(side === "client" ? [`${CORE_CLIENT_PACKAGE}.*`] : []), ...(imports ?? [])],
        body,
        members,
      }),
      ...withoutUndefined(rest),
    });
  };
}

/** Templates calling into the core (`side` defaults to `server`; pass `any` for either side). */
export const coreTask = moduleTasks(CORE);

/** Client templates calling into the client core (`Settle`, `View`, `ClientGame`, `HeldKeys`). */
export const coreClientTask = moduleTasks(CORE_CLIENT);

/** `{...options}` without undefined values, so a task's args (and run options) stay minimal. */
export function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function withoutUndefined<T extends object>(value: T): T {
  return defined(value) as T;
}

/** Slack between an in-game wait's own budget and the task deadline, so the wait reports first. */
export const WAIT_SLACK_MS = 5_000;

/** A task deadline above an in-game budget of `waitMs` (0 = none stays none). */
export function deadlineAbove(waitMs: number): number {
  return waitMs === 0 ? 0 : waitMs + WAIT_SLACK_MS;
}

/**
 * For a template that waits in the game: the in-game budget (`wait`, passed in the args as
 * `{wait: {timeoutMs}}` and read by `Wait.Options.of`) and run options whose deadline sits above it.
 */
export function waitBudget(timeoutMs: number | undefined, signal?: AbortSignal, defaultMs = DEFAULT_WAIT_TIMEOUT_MS): {
  wait: { timeoutMs: number };
  run: RunTemplateOptions;
} {
  const wait = timeoutMs ?? defaultMs;
  return { wait: { timeoutMs: wait }, run: { timeoutMs: deadlineAbove(wait), ...(signal ? { signal } : {}) } };
}
