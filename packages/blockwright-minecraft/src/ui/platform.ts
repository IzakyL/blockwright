import type { UiCallOptions, UiCodegen, UiPlatform, UiProbeOutcome } from "@izakyl/blockwright-ui";
import { UiWaitTimeoutError } from "@izakyl/blockwright-ui";
import {
  defineTask,
  isMinecraftError,
  javaTask,
  type MinecraftTimeoutError,
  type MinecraftClient,
  type PrefabModule,
  type ReflectQuerySpec,
} from "../core/index.js";
import { clientTask } from "../client/module.js";
import { GLFW_KEY_ENTER, click, key, scroll } from "../client/input.js";
import type { KeyModifiers, MouseButtonName } from "../client/types.js";

/**
 * One piece of in-game reading for the UI host: Java statements ending in `return <value>;`, run on the
 * client thread with `ctx` (the Context) and `args` (an Args over {@link args}) in scope. All probes of a
 * read are compiled into one task and run in the same client-thread turn; a probe that throws answers
 * `{error: {code, message}}` without failing the others. Probes must answer synchronously.
 */
export interface MinecraftUiProbe {
  body: string;
  /** Extra imports: class names or `pkg.*`. */
  imports?: readonly string[];
  /** Modules the body references beyond core. */
  modules?: readonly PrefabModule[];
  /** JSON arguments, read through `args`. */
  args?: Record<string, unknown>;
}

/** A probe that runs one reflect query (see ReflectQuerySpec); a route that does not resolve answers its error. */
export function uiReflectProbe(spec: ReflectQuerySpec): MinecraftUiProbe {
  return { body: "return Reflection.query(ctx, args);", args: spec as unknown as Record<string, unknown> };
}

const READ_MEMBERS = `private static Object part(Callable<Object> read) {
    Map<String, Object> outcome = new LinkedHashMap<>();
    try {
        outcome.put("ok", read.call());
    } catch (TaskException failure) {
        outcome.put("error", Values.obj("code", failure.code(), "message", String.valueOf(failure.getMessage())));
    } catch (Exception | LinkageError failure) {
        outcome.put("error", Values.obj("code", "exception", "message", failure.toString()));
    }
    return outcome;
}`;

/** The one task a set of probes compiles to; the same probes (in the same order) give the same source. */
export function uiReadSource(probes: readonly MinecraftUiProbe[]): string {
  const imports = [...new Set(probes.flatMap((probe) => probe.imports ?? []))];
  const parts = probes.map((probe, at) => `out.put("p${at}", part(() -> {
    Args args = Args.of(ctx.arg("p${at}"), "p${at}");
${probe.body.trim().split("\n").map((line) => `    ${line}`).join("\n")}
}));`);
  return javaTask({
    imports,
    members: READ_MEMBERS,
    body: ["Map<String, Object> out = new LinkedHashMap<>();", ...parts, "return out;"].join("\n"),
  });
}

async function readProbes(
  client: MinecraftClient,
  probes: Readonly<Record<string, MinecraftUiProbe>>,
  options: UiCallOptions = {},
): Promise<Record<string, UiProbeOutcome>> {
  const entries = Object.entries(probes);
  if (entries.length === 0) return {};
  const modules = [...new Set(entries.flatMap(([, probe]) => probe.modules ?? []))];
  const template = defineTask<Record<string, unknown>, Record<string, UiProbeOutcome>>({
    name: "ui.read",
    side: "client",
    modules,
    source: uiReadSource(entries.map(([, probe]) => probe)),
  });
  const args = Object.fromEntries(entries.map(([, probe], at) => [`p${at}`, probe.args ?? {}]));
  const answer = await client.run(template, args, options.signal ? { signal: options.signal } : {});
  return Object.fromEntries(entries.map(([name], at) => [name, answer[`p${at}`] ?? {
    error: { code: "no-answer", message: `the read task answered nothing for ${name}` },
  }]));
}

// A hover shows once a frame has been drawn with the cursor there; two to be safe.
const HOVER = clientTask<{ x: number; y: number }, Record<string, unknown>>("ui.hover", `Args args = Args.of(ctx);
Map<String, Object> moved = Mouse.move(ClientGame.mc(ctx), args.number("x"), args.number("y"));
return Wait.ticks(ctx, Wait.Clock.FRAME, 2).thenApply(done -> moved);`);

/** The cursor at GUI-scaled (x, y), answered once two frames have been drawn with it there. */
export function uiHover(client: MinecraftClient, at: { x: number; y: number }): Promise<Record<string, unknown>> {
  return client.run(HOVER, { x: at.x, y: at.y });
}

function clickOptions(action: { button?: MouseButtonName; modifiers?: readonly string[]; double?: boolean }) {
  return {
    ...(action.button && action.button !== "left" ? { button: action.button } : {}),
    ...(action.modifiers?.length ? { modifiers: [...action.modifiers] as KeyModifiers } : {}),
    ...(action.double ? { double: true } : {}),
  };
}

/** `, {...}` for a statement's trailing options argument, or nothing when there are none. */
export function optionsArg(options: Record<string, unknown>): string {
  return Object.keys(options).length > 0 ? `, ${JSON.stringify(options)}` : "";
}

function describeClick(action: { button?: string; modifiers?: readonly string[]; double?: boolean }): string {
  const button = action.button ?? "left";
  const modifiers = action.modifiers?.length ? `${action.modifiers.join("+")}+` : "";
  return `${modifiers}${button === "left" ? "" : `${button} `}${action.double ? "double-click" : "click"}`;
}

const FROM = "@izakyl/blockwright-minecraft";

/** Statements that type into what has focus (and press Enter), for codegen. */
export function typeCode(text: string, submit: boolean | undefined): string {
  return `await input.key(client, { text: ${JSON.stringify(text)} });`
    + (submit ? ` await input.key(client, { keyCode: ${GLFW_KEY_ENTER} });` : "");
}

/**
 * The Minecraft platform for `@izakyl/blockwright-ui`: probes are Java run in one client task, and pointer input
 * goes through the mouse (`input.click`, `input.scroll`, a cursor move for hovers) and the keyboard (`input.key`).
 */
export const minecraftUiPlatform: UiPlatform<MinecraftClient, MinecraftUiProbe> = {
  read: readProbes,

  async point(client, at, action) {
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    const point = { x, y };
    switch (action.kind) {
      case "click":
        await click(client, point, clickOptions(action));
        return { summary: `${describeClick(action)} at ${x},${y}`, point };
      case "hover":
        await uiHover(client, point);
        return { summary: `hovering ${x},${y}`, point };
      case "scroll":
        await scroll(client, { at: point, yOffset: action.lines });
        return { summary: `scrolled ${action.lines} at ${x},${y}`, point };
      case "type":
        await click(client, point);
        await key(client, { text: action.text });
        if (action.submit) await key(client, { keyCode: GLFW_KEY_ENTER });
        return { summary: `typed ${JSON.stringify(action.text)} at ${x},${y}${action.submit ? " and pressed enter" : ""}`, point };
    }
  },

  pointCodegen(at, action): UiCodegen {
    const x = Math.round(at.x);
    const y = Math.round(at.y);
    switch (action.kind) {
      case "click":
        return { imports: [{ from: FROM, names: ["input"] }], code: `await input.click(client, { x: ${x}, y: ${y} }${optionsArg(clickOptions(action))});` };
      case "hover":
        return { imports: [{ from: FROM, names: ["input"] }], code: `await input.move(client, { x: ${x}, y: ${y} });` };
      case "scroll":
        return { imports: [{ from: FROM, names: ["input"] }], code: `await input.scroll(client, { at: { x: ${x}, y: ${y} }, yOffset: ${action.lines} });` };
      case "type":
        return {
          imports: [{ from: FROM, names: ["input"] }],
          code: `await input.click(client, { x: ${x}, y: ${y} }); ${typeCode(action.text, action.submit)}`,
        };
    }
  },
};

/**
 * Runs an in-game wait as a UI wait, answering how long it took: an in-game `wait-timeout` is thrown as a
 * {@link UiWaitTimeoutError} (with what the check last saw, and the original as its cause); every other
 * failure is thrown as it is.
 */
export async function uiWait(wait: () => Promise<unknown>): Promise<{ elapsedMs: number }> {
  const started = Date.now();
  try {
    const result = await wait();
    const elapsed = (result as { elapsedMs?: unknown } | undefined)?.elapsedMs;
    return { elapsedMs: typeof elapsed === "number" ? elapsed : Date.now() - started };
  } catch (error) {
    if (!isMinecraftError(error, "wait-timeout")) throw error;
    const { last, elapsedMs } = error as MinecraftTimeoutError;
    throw new UiWaitTimeoutError(error.message, {
      elapsedMs: elapsedMs ?? Date.now() - started,
      ...(last !== undefined ? { last, detail: `last seen: ${JSON.stringify(last)}` } : {}),
      cause: error,
    });
  }
}
