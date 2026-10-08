import { z } from "zod";
import type { ZodRawShape } from "zod";
import { input, MinecraftTimeoutError, player, tick, world } from "@izakyl/blockwright-minecraft";
import { UiWaitTimeoutError } from "@izakyl/blockwright-ui";
import type { UiAction, UiSelector, UiTarget } from "@izakyl/blockwright-ui";
import { needs, parser } from "./schema.js";
import type { Args } from "./schema.js";
import type { BlockwrightSession } from "./session.js";
import type { RecordedStep } from "./spec.js";

export interface ActionOutcome {
  header: string;
  steps: RecordedStep[];
  failed?: boolean;
}

/** A step a tool or a batch step carries out; it parses its own arguments against its shape. */
export interface Action<S extends ZodRawShape = ZodRawShape> {
  shape: S;
  run: (session: BlockwrightSession, args: unknown) => Promise<ActionOutcome>;
}

function action<S extends ZodRawShape>(
  shape: S,
  run: (session: BlockwrightSession, args: Args<S>) => Promise<ActionOutcome>,
): Action<S> {
  const parse = parser(shape);
  return { shape, run: (session, args) => run(session, parse(args)) };
}

/** Commands as the server console, in one task (one tick, one round trip): `world.command`. */
export const commandAction = action({
  command: z.string().optional(),
  commands: z.array(z.string()).min(1).max(64).optional(),
}, async (session, args) => {
  const commands = args.commands ?? [needs(args, "command")];
  const results = await world.command(session.server(), commands, { allowFailure: true });
  const lines: string[] = [];
  const steps: RecordedStep[] = [];
  for (const result of results) {
    const output = result.output.length > 0 ? result.output.join("\n") : "(no output)";
    lines.push(`/${result.command} -> ${result.success ? "ok" : result.invoked ? "failed" : "not run"}\n${output}`);
    steps.push({ kind: "command", command: result.command, succeeded: result.success });
  }
  return { header: lines.join("\n"), steps, failed: results.some((result) => !result.success) };
});

const uiShape = {
  op: z.enum(["click", "hover", "reveal", "scroll", "type", "wait"]).optional(),
  ref: z.string().optional().describe("[eN] ref from an observation or an action's ui diff; refs stay valid across reads"),
  adapter: z.string().optional().describe("with selector: the UI adapter it belongs to"),
  selector: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]))
    .optional()
    .describe("an adapter's own locator, e.g. minecraft { label } | { className, index? } | { slot }"),
  x: z.number().optional(),
  y: z.number().optional(),
  force: z.boolean().optional().describe("act on an element even though a slot beneath it would take the click"),
  timeoutMs: z.number().int().min(1).optional(),
  button: z.enum(["left", "right", "middle"]).optional(),
  modifiers: z.array(z.enum(["shift", "ctrl", "alt"])).optional(),
  double: z.boolean().optional().describe("a double click; separate clicks on one spot are kept apart so they never merge into one"),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  lines: z.number().int().optional(),
  state: z.enum(["actionable", "absent"]).optional(),
};

type UiArgs = Args<typeof uiShape>;

/** A screen target from tool args: a ref, an adapter plus its selector, or a GUI point. */
export function uiTarget(args: UiArgs): UiTarget {
  if (args.ref !== undefined) return { ref: args.ref };
  if (args.selector !== undefined) {
    if (args.adapter === undefined) throw new Error("a selector needs the adapter it belongs to, e.g. adapter=minecraft");
    return { adapter: args.adapter, selector: args.selector as UiSelector };
  }
  if (args.x !== undefined && args.y !== undefined) return { x: args.x, y: args.y };
  throw new Error("this needs a ref from an observation, an adapter with a selector, or both x and y");
}

async function onScreen(session: BlockwrightSession, args: UiArgs, act: UiAction): Promise<ActionOutcome> {
  const result = await session.ui.act(session.client(), uiTarget(args), act, {
    force: args.force === true,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });
  const code = session.ui.codegen(result.entry, act, result.point);
  const summary = `${args.ref !== undefined ? `[${args.ref}] ` : ""}${result.summary}`;
  return { header: summary, steps: [{ kind: "ui", summary, ...(code ? { code } : {}) }] };
}

/** Screen actions through the UI host: the adapter that owns the element acts its own way. */
export const screenAction = action(uiShape, async (session, args) => {
  switch (args.op ?? "click") {
    case "click":
      return onScreen(session, args, {
        kind: "click",
        ...(args.button === undefined ? {} : { button: args.button }),
        ...(args.modifiers === undefined ? {} : { modifiers: args.modifiers }),
        ...(args.double === true ? { double: true } : {}),
      });
    case "hover":
      return onScreen(session, args, { kind: "hover" });
    case "reveal":
      return onScreen(session, args, { kind: "scrollIntoView" });
    case "scroll":
      return onScreen(session, args, { kind: "scroll", lines: args.lines ?? -1 });
    case "type":
      return onScreen(session, args, { kind: "type", text: needs(args, "text"), submit: args.submit === true });
    case "wait": {
      const target = uiTarget(args);
      if ("x" in target) throw new Error("op wait needs a ref or a selector, not a point");
      const state = args.state ?? "actionable";
      const what = "ref" in target ? `[${target.ref}]` : `${target.adapter} ${JSON.stringify(target.selector)}`;
      const steps: RecordedStep[] = [{ kind: "ui", summary: `wait until ${what} is ${state}` }];
      try {
        const waited = await session.ui.waitFor(session.client(), target, state,
          args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {});
        return { header: `${what} became ${state} after ${waited.elapsedMs}ms`, steps };
      } catch (error) {
        if (!(error instanceof UiWaitTimeoutError)) throw error;
        return {
          header: `${what} did not become ${state} within ${error.elapsedMs}ms${error.detail ? `: ${error.detail}` : ""}`,
          steps,
          failed: true,
        };
      }
    }
  }
});

/** A keybind tap/press/release, or text typed into what has focus: `input.key`. */
export const keyAction = action({
  keybind: z.string().optional(),
  action: z.enum(["tap", "press", "release"]).optional(),
  text: z.string().optional(),
}, async (session, args) => {
  const client = session.client();
  if (args.text !== undefined) {
    await input.key(client, { text: args.text });
    return { header: `typed ${JSON.stringify(args.text)}`, steps: [{ kind: "type", text: args.text }] };
  }
  const keybind = needs(args, "keybind");
  const pressed = args.action ?? "tap";
  await input.key(client, { keybind, action: pressed });
  return { header: `${pressed} ${keybind}`, steps: [{ kind: "key", keybind, action: pressed }] };
});

/** Turns the player: `player.place`. */
export const lookAction = action({ yaw: z.number(), pitch: z.number() }, async (session, { yaw, pitch }) => {
  await player.place(session.client(), { yaw, pitch });
  return { header: `looking yaw=${yaw} pitch=${pitch}`, steps: [{ kind: "look", yaw, pitch }] };
});

/** Freeze/unfreeze (`tick.freeze`), wait for a condition while sprinting (`world.waitFor`), then sprint ticks (`tick.sprint`). */
export const tickAction = action({
  ticks: z.number().int().min(1).optional(),
  frozen: z.boolean().optional(),
  until: z.string().optional(),
  maxTicks: z.number().int().min(1).optional(),
  stepTicks: z.number().int().min(1).optional(),
}, async (session, args) => {
  const server = session.server();
  const parts: string[] = [];
  const steps: RecordedStep[] = [];
  let failed = false;
  if (args.frozen !== undefined) {
    await tick.freeze(server, args.frozen);
    parts.push(args.frozen ? "frozen" : "running");
    steps.push({ kind: "freeze", frozen: args.frozen });
  }
  if (args.until !== undefined) {
    const maxTicks = args.maxTicks ?? 200;
    const stepTicks = args.stepTicks;
    try {
      const result = await world.waitFor(server, args.until, { maxTicks, ...(stepTicks ? { stepTicks } : {}) });
      parts.push(`predicate passed after ${result.ticks} ticks`);
    } catch (error) {
      if (!(error instanceof MinecraftTimeoutError)) throw error;
      failed = true;
      const reason = (error.detail as { reason?: string } | undefined)?.reason ?? "timeout";
      parts.push(`predicate never passed within ${maxTicks} ticks (${reason}; last ${JSON.stringify(error.last)})`);
    }
    steps.push({ kind: "until-command", command: args.until, maxTicks, ...(stepTicks ? { stepTicks } : {}) });
  }
  if (args.ticks !== undefined) {
    const advanced = await tick.sprint(server, args.ticks);
    parts.push(`advanced ${advanced.ticks} ticks (gameTime ${advanced.gameTime})`);
    steps.push({ kind: "ticks", ticks: args.ticks });
  }
  if (parts.length === 0) parts.push("no change");
  return { header: `tick: ${parts.join(", ")}`, steps, failed };
});
