import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { ZodRawShape } from "zod";
import { camera, evidence, GameLaunchError } from "@izakyl/blockwright-minecraft";
import type { InstanceRole } from "@izakyl/blockwright-client";
import { commandAction, keyAction, lookAction, screenAction, tickAction } from "./actions.js";
import type { Action, ActionOutcome } from "./actions.js";
import { UI_SECTIONS, diffObservations } from "./diff.js";
import type { UiSection } from "./diff.js";
import { logsShape, readLogs } from "./logs.js";
import type { LogTarget, LogsRequest } from "./logs.js";
import { drawShape, recordShape, runDraw, runRecord } from "./media.js";
import { observed } from "./observe.js";
import { queryShape, runQuery } from "./query.js";
import { failure, text } from "./result.js";
import type { ToolContent, ToolImageContent, ToolResult, ToolTextContent } from "./result.js";
import { parser } from "./schema.js";
import type { Args } from "./schema.js";
import { captureShotsDetailed, shotShape } from "./shots.js";
import type { CapturedShots } from "./shots.js";
import { BlockwrightSession } from "./session.js";
import { describeStep, renderSpec } from "./spec.js";
import type { RecordedStep } from "./spec.js";
import { runTask, taskShape } from "./task.js";

export type Cap = "core" | "vision" | "query" | "record";

export const ALL_CAPS: Cap[] = ["core", "vision", "query", "record"];

export const DEFAULT_CAPS: Cap[] = ["core", "vision", "query"];

export type { ToolContent, ToolImageContent, ToolResult, ToolTextContent };

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  cap: Cap;
  readOnly: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  inputSchema: ZodRawShape;
  handler: (session: BlockwrightSession, args: Record<string, unknown>) => Promise<ToolResult>;
}

/** A tool whose handler gets its arguments parsed against its input schema. */
function tool<S extends ZodRawShape>(
  definition: Omit<ToolDefinition, "inputSchema" | "handler"> & {
    inputSchema: S;
    handler: (session: BlockwrightSession, args: Args<S>) => Promise<ToolResult>;
  },
): ToolDefinition {
  const parse = parser(definition.inputSchema);
  return { ...definition, handler: (session, args) => definition.handler(session, parse(args)) };
}

/** A tool that carries out an action and answers with what it changed. */
function actionTool<S extends ZodRawShape>(
  action: Action<S>,
  definition: Omit<ToolDefinition, "inputSchema" | "handler">,
): ToolDefinition {
  return tool({ ...definition, inputSchema: action.shape, handler: acting(action) });
}

function acting(action: Action) {
  return async (session: BlockwrightSession, args: unknown): Promise<ToolResult> => {
    const outcome = await action.run(session, args);
    session.record(...outcome.steps);
    return observed(session, outcome.header);
  };
}

function logTargets(session: BlockwrightSession, args: LogsRequest): LogTarget[] {
  const wanted: InstanceRole[] = args.role === undefined ? ["server", "client"] : [args.role];
  const named = args.instance;
  const root = session.options.cwd ?? process.cwd();
  const records = session.registered();
  const targets: LogTarget[] = [];
  for (const each of wanted) {
    let bound;
    try {
      bound = session.instance(each);
    } catch {
      bound = undefined;
    }
    if (bound && (named === undefined || bound.instanceId.includes(named))) {
      targets.push({
        role: each,
        instanceId: bound.instanceId,
        instanceDir: bound.instanceDir,
        tracePath: bound.tracePath,
      });
      continue;
    }
    for (const record of records) {
      if (record.role !== each || (named !== undefined && !record.instanceId.includes(named))) {
        continue;
      }
      targets.push({
        role: each,
        instanceId: record.instanceId,
        instanceDir: record.instanceDir,
        tracePath: record.tracePath ? resolve(root, record.tracePath) : undefined,
      });
    }
  }
  return targets;
}

const BATCH_ACTIONS: Record<string, Action> = { command: commandAction, ui: screenAction, key: keyAction, tick: tickAction, look: lookAction };

const parseShot = parser(shotShape);

const batchShape = {
  steps: z
    .array(z.object({
      tool: z.enum(["command", "ui", "key", "tick", "look", "observe", "screenshot"]),
      args: z.record(z.unknown()).optional(),
    }))
    .min(1)
    .max(50),
  stopOnFailure: z.boolean().optional(),
};

async function runBatch(session: BlockwrightSession, args: Args<typeof batchShape>): Promise<ToolResult> {
  const { steps } = args;
  const stopOnFailure = args.stopOnFailure ?? true;
  const lines: string[] = [];
  let failures = 0;
  let ran = 0;
  for (const [index, step] of steps.entries()) {
    const stepArgs = step.args ?? {};
    const prefix = `${index + 1}. ${step.tool}`;
    let failed = false;
    try {
      let summary: string;
      const action = BATCH_ACTIONS[step.tool];
      if (action) {
        const outcome: ActionOutcome = await action.run(session, stepArgs);
        session.record(...outcome.steps);
        summary = outcome.header;
        failed = outcome.failed === true;
      } else if (step.tool === "observe") {
        await session.settle();
        const observation = await session.observe();
        summary = `refs refreshed: ${observation.ui?.refOf.size ?? 0} addressable ui elements`;
      } else if (step.tool === "screenshot") {
        const request = parseShot(stepArgs);
        const shot = await captureShotsDetailed(session, { ...request, inline: false });
        session.record(screenshotStep(request.label, shot));
        summary = shot.result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
        failed = shot.result.isError === true;
      } else {
        throw new Error(`a batch step cannot run ${step.tool}`);
      }
      lines.push(`${failed ? "✗" : "✓"} ${prefix}: ${indent(summary)}`);
    } catch (error) {
      failed = true;
      lines.push(`✗ ${prefix}: ${error instanceof Error ? error.message : String(error)}`);
    }
    ran += 1;
    if (failed) {
      failures += 1;
      if (stopOnFailure) {
        break;
      }
    }
  }
  const skipped = steps.length - ran;
  const header = [
    `batch: ${ran} of ${steps.length} steps ran, ${failures} failed${skipped > 0 ? `, stopped before the remaining ${skipped}` : ""}`,
    ...lines,
  ].join("\n");
  return observed(session, header);
}

function indent(value: string): string {
  return value.split("\n").join("\n     ");
}

function screenshotStep(label: string | undefined, shot: CapturedShots): RecordedStep {
  return { kind: "screenshot", label: label ?? "shot", cameras: shot.cameras };
}

function stepsSinceLaunch(steps: RecordedStep[]): RecordedStep[] {
  let start = 0;
  steps.forEach((step, index) => {
    if (step.kind === "launch") {
      start = index;
    }
  });
  return steps.slice(start);
}

export const TOOLS: ToolDefinition[] = [
  tool({
    name: "blockwright_status",
    title: "Session status",
    description:
      "Whether this session holds a server/client pair, which config it was launched with, and when. "
      + "Costs nothing.",
    cap: "core",
    readOnly: true,
    idempotent: true,
    inputSchema: {},
    handler: async (session) => text(JSON.stringify(session.status(), null, 2)),
  }),
  tool({
    name: "blockwright_launch",
    title: "Launch a server/client pair",
    description:
      "Start a fresh server and client JVM and wait for both to be ready — about 14 seconds: the "
      + "server reaches world-ready around 8s and the client joins around 13.5s. The pair belongs to "
      + "this session and lives until blockwright_close or until this MCP server exits; nothing else "
      + "can connect to it. Launching while a pair is up is refused unless restart=true, which closes "
      + "the old pair first — do that after rebuilding a mod, since new code only loads in new JVMs. Ticks "
      + "are frozen on launch: the world does not advance until you call blockwright_tick. A failed attempt "
      + "is launched again (attempts, default 2) unless the game left a crash behind; each failed attempt's "
      + "evidence — how the processes ended, the crash report summary, log trouble — comes back in the answer.",
    cap: "core",
    readOnly: false,
    inputSchema: {
      config: z.string().optional(),
      restart: z.boolean().optional(),
      attempts: z.number().int().min(1).max(5).optional(),
    },
    handler: async (session, args) => {
      let status;
      try {
        status = await session.launch(args);
      } catch (error) {
        if (error instanceof GameLaunchError) return failure(error.message);
        throw error;
      }
      const off = status.ui.filter((adapter) => adapter.off !== undefined);
      const adapters = `ui adapters: ${status.ui.map((adapter) => adapter.id).join(", ")}`
        + off.map((adapter) => `\n  ${adapter.id} is off: ${adapter.off}`).join("");
      const retried = session.launchFailures.length > 0
        ? `\nretried ${session.launchFailures.length} failed attempt(s):\n${session.launchFailures.map(evidence.format).join("\n---\n")}`
        : "";
      return observed(session, `launched: ${JSON.stringify(status.instances)}\n${adapters}${retried}`);
    },
  }),
  tool({
    name: "blockwright_close",
    title: "Stop the pair",
    description:
      "Stop the client and server JVMs this session launched. The world is gone afterwards; "
      + "recorded steps stay for blockwright_export.",
    cap: "core",
    readOnly: false,
    destructive: true,
    inputSchema: {},
    handler: async (session) => {
      const before = session.status().instances;
      const closed = await session.close();
      const ended = (["server", "client"] as const).flatMap((role) => {
        const result = closed?.[role];
        return result ? [`${role}: ${evidence.formatCrash(evidence.closeCrash(result)).join("\n  ")}`] : [];
      });
      return text([`stopped: ${JSON.stringify(before)}`, ...ended].join("\n"));
    },
  }),
  tool({
    name: "blockwright_observe",
    title: "Observe the game",
    description:
      "The current state as text: the open screen read through the UI adapters (vanilla widgets and "
      + "slots and whatever extra adapters read, as one tree), player position and health, what the crosshair is on, "
      + "nearby entities, recent chat, and the server's tick state. Every addressable element is labelled [eN]; pass "
      + "the ref to blockwright_ui. A ref names the element, not a position, so it "
      + "stays valid across observations and actions for as long as the element exists. mode=diff, the "
      + "default, reports only what moved since the last observation in this session and costs a fraction "
      + "of the tokens; ask for mode=full when you need the whole picture. mode=evidence takes what a failing "
      + "test would attach: the full observation, the player as the server sees it, containers and entities "
      + "around it, screenshots of the player's view and the spot from every side (saved, not inline), each "
      + "instance's log trouble and crash summary. `show` and `hide` pick the "
      + "sections (screen, player, cursor, hud, messages, nearby, tick) that this and every later action "
      + "report; the rest are left out of the automatic diff.",
    cap: "core",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      mode: z.enum(["diff", "full", "evidence"]).optional(),
      nearbyRadius: z.number().optional(),
      messages: z.number().int().min(0).optional(),
      uiLimit: z.number().int().min(1).max(1000).optional().describe("elements listed in mode=full (default 80)"),
      show: z.array(z.enum(UI_SECTIONS as unknown as [UiSection, ...UiSection[]])).optional(),
      hide: z.array(z.enum(UI_SECTIONS as unknown as [UiSection, ...UiSection[]])).optional(),
    },
    handler: async (session, args) => {
      args.show?.forEach((section) => session.setUiSection(section, true));
      args.hide?.forEach((section) => session.setUiSection(section, false));
      if (args.mode === "evidence") {
        const taken = await session.evidence({ ...(args.nearbyRadius !== undefined ? { radius: args.nearbyRadius } : {}) });
        return text(evidence.format(taken));
      }
      const previous = session.lastObservation();
      const observation = await session.observe({
        ...(args.nearbyRadius === undefined ? {} : { nearby: { radius: args.nearbyRadius } }),
        ...(args.messages === undefined ? {} : { messages: args.messages }),
      });
      if (args.mode === "full" || !previous) {
        const note = previous ? "" : "no earlier observation in this session, so this one is full\n\n";
        return text(`${note}${evidence.formatObservation(observation, args.uiLimit !== undefined ? { uiLimit: args.uiLimit } : {})}`);
      }
      const changes = diffObservations(previous, observation, { sections: session.uiSections() });
      return text(changes.length > 0
        ? `changes since the last observation:\n${changes}`
        : "no change since the last observation; ask for mode=full to see the whole state");
    },
  }),
  actionTool(screenAction, {
    name: "blockwright_ui",
    title: "Click, hover, scroll, type into or wait for an element",
    description:
      "Act on the open screen. Aim with an [eN] ref, an adapter's selector, or GUI coordinates x/y. "
      + "op=click (the default) clicks it — button and modifiers cover right-clicks and shift-clicks; "
      + "op=hover moves the cursor onto it (tooltips); op=reveal scrolls it into view; op=scroll turns the "
      + "wheel over it by `lines` (negative scrolls down); op=type clicks it and types `text`, then presses "
      + "enter with submit=true — how chat and text fields are filled; op=wait waits, without advancing "
      + "ticks, until it is actionable (or absent with state=absent), within timeoutMs. The adapter that "
      + "owns the element acts its own way, e.g. scrolling it into view or checking the press against what its "
      + "UI library says was hit. Answers with what changed; elements that appeared come back "
      + "with their refs.",
    cap: "core",
    readOnly: false,
  }),
  actionTool(keyAction, {
    name: "blockwright_key",
    title: "Press a keybind or type",
    description:
      "Hold, release, or tap a Minecraft keybind such as key.inventory, key.forward, key.jump (action=tap "
      + "presses and releases), or pass `text` instead to type it into whatever has focus, such as the "
      + "chat box or a text field.",
    cap: "core",
    readOnly: false,
  }),
  actionTool(commandAction, {
    name: "blockwright_command",
    title: "Run server commands",
    description:
      "Run a command on the server as the console, without the leading slash — or several, in order, "
      + "with `commands`. Use it to set up world state (setblock, fill, summon, give, tp) rather than "
      + "driving it through the UI. It changes the world and there is no undo short of relaunching.",
    cap: "core",
    readOnly: false,
    destructive: true,
  }),
  tool({
    name: "blockwright_task",
    title: "Run a Java task in the game",
    description:
      "Run a Java task in the live game — how you set up state no command reaches (build a colony, bind an "
      + "item to it, call a mod's own API) or read state no query shows. Give the task one of three ways: "
      + "`source`, a whole task (`public final class Task { public static Object run(dev.blockwright.api.Context "
      + "ctx) throws Exception { ... } }`); `body`, only the body of run(ctx), with the prefab's imports (add "
      + "more with `imports`); or `file`, a .java file on disk holding a whole task. `modules` loads (or "
      + "reloads, when changed) library source directories first, in order. ctx gives args (ctx.arg(name), or "
      + "Args.of(ctx) for checked reads), ctx.server(), ctx.client() on a client, ctx.emit(value) for more "
      + "outputs, thread hops and a scope; the prefab's helpers (Levels, GameJson, Values, Wait, Ticks) are "
      + "there. Every output streams back (binary ones saved as files) and the run's end is reported: ok, "
      + "error (compile diagnostics, exception, timeout) or cancelled. role defaults to server; thread "
      + "defaults to the role's game thread. It changes live state and cannot be undone.",
    cap: "core",
    readOnly: false,
    destructive: true,
    inputSchema: taskShape,
    handler: runTask,
  }),
  actionTool(tickAction, {
    name: "blockwright_tick",
    title: "Advance or freeze time",
    description:
      "The world is frozen by default so it holds still while you think. Advance it deliberately with "
      + "ticks (20 ticks = 1 second of game time), or set frozen=false to let it run freely. Anything "
      + "that needs time to happen — falling, growing, mobs moving, redstone settling — needs this. "
      + "Waiting for a condition is one call: `until` is a command the server evaluates as a predicate "
      + "every step, as in until=\"execute if block 10 64 10 minecraft:redstone_lamp[lit=true]\"; it "
      + "stops the moment it passes, within maxTicks (200 by default).",
    cap: "core",
    readOnly: false,
  }),
  actionTool(lookAction, {
    name: "blockwright_look",
    title: "Aim the camera",
    description: "Point the player's view at an absolute yaw and pitch, in degrees.",
    cap: "core",
    readOnly: false,
  }),
  tool({
    name: "blockwright_batch",
    title: "Run several steps in one call",
    description:
      "Carry out a sequence of steps in one round trip and observe once at the end. Each step is "
      + "{ tool, args } where tool is command, ui, key, tick, look, observe or screenshot, and args are "
      + "that tool's arguments. By default the batch stops at the first step that fails "
      + "(stopOnFailure=false runs them all). The answer lists every step with ✓ or ✗, then the usual "
      + "diff.",
    cap: "core",
    readOnly: false,
    destructive: true,
    inputSchema: batchShape,
    handler: runBatch,
  }),
  tool({
    name: "blockwright_export",
    title: "Turn the session into a spec",
    description:
      "Every action this session carried out is recorded. op=list numbers the steps since the last "
      + "launch; op=spec writes them as a Playwright test for @izakyl/blockwright-test — commands (one that "
      + "took effect must take effect again), Java tasks (with the modules they loaded), screen actions (as each UI adapter's own "
      + "call, coordinates only as a last resort), keys, ticks and waits, and screenshots — to `path` "
      + "(default under the artifact dir), optionally only steps from..to. op=clear forgets the "
      + "recording. The spec replays what you did; add the assertions it should guard by hand.",
    cap: "core",
    readOnly: false,
    inputSchema: {
      op: z.enum(["list", "spec", "clear"]),
      name: z.string().optional(),
      path: z.string().optional(),
      from: z.number().int().min(1).optional(),
      to: z.number().int().min(1).optional(),
    },
    handler: async (session, args) => {
      const op = args.op;
      if (op === "clear") {
        session.clearSteps();
        return text("recording cleared");
      }
      const steps = stepsSinceLaunch(session.steps());
      if (op === "list") {
        return text(
          steps.length === 0
            ? "nothing recorded since the last launch"
            : steps.map((step, index) => `${index + 1}. ${describeStep(step)}`).join("\n"),
        );
      }
      const from = args.from ?? 1;
      const to = args.to ?? steps.length;
      const chosen = steps.slice(from - 1, to);
      if (chosen.length === 0) {
        throw new Error(`no steps in ${from}..${to}; op=list shows ${steps.length}`);
      }
      const name = args.name ?? "recorded session";
      const spec = renderSpec({
        name,
        config: session.launchedConfig,
        steps: chosen,
      });
      const slug = name.replace(/[^0-9A-Za-z_-]+/g, "-").replace(/^-+|-+$/g, "") || "recorded";
      const path = resolve(session.cwd, args.path ?? resolve(session.artifactDir, `${slug}.spec.ts`));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, spec);
      return text(`wrote ${path} (${chosen.length} steps)\n\n${spec}`);
    },
  }),
  tool({
    name: "blockwright_logs",
    title: "Read the game logs",
    description:
      "The first signal when a mod misbehaves: the instance's own log plus everything the driver "
      + "captured from stdout and stderr, merged and de-duplicated. Filter with role, since (an ISO "
      + "timestamp or a window like 5m), level (>= TRACE/DEBUG/INFO/WARN/ERROR/FATAL) and grep, a "
      + "regular expression. On top of the lines it pulls out mixin apply failures, registry and "
      + "datapack errors, groups exception stacks, and summarises any crash report it finds. Works on "
      + "an instance this session did not launch, as long as it is in the registry.",
    cap: "core",
    readOnly: true,
    idempotent: true,
    inputSchema: logsShape,
    handler: async (session, args) => text(readLogs(logTargets(session, args), args)),
  }),
  tool({
    name: "blockwright_screenshot",
    title: "See the game",
    description:
      "Render the client to a PNG. By default it answers with the path and the size only, which costs "
      + "almost nothing — pass inline=true when you actually need to look at the frame. Pass `cameras` "
      + "to shoot the same frozen world from several viewpoints in one call, or `bounds` { min, max } "
      + `with a preset (${camera.PRESETS.join(", ")}) to have the viewpoints placed for you: elevations `
      + "looks at each side, top straight down, iso from the four diagonals, orbit from presetCount "
      + "evenly spaced angles — every camera framed on the whole box. Several frames come back inline as "
      + "numbered images, saved small enough that together they span about maxWidth (default 1024).",
    cap: "vision",
    readOnly: true,
    inputSchema: shotShape,
    handler: async (session, args) => {
      const shot = await captureShotsDetailed(session, args);
      if (shot.result.isError !== true) {
        session.record(screenshotStep(args.label, shot));
      }
      return shot.result;
    },
  }),
  tool({
    name: "blockwright_draw",
    title: "Capture draw calls",
    description:
      "Record what the client actually draws — HUD batches or in-world batches — instead of inferring it "
      + "from pixels. op=hud.frames / world.frames records the next `frames` complete frames in one call; "
      + "hud.start / world.start begins a capture that runs while you act, and the matching .stop answers "
      + "the frames with their entries. Reach for it when a rendering bug is about geometry or ordering rather "
      + "than colour.",
    cap: "vision",
    readOnly: false,
    inputSchema: drawShape,
    handler: runDraw,
  }),
  tool({
    name: "blockwright_query",
    title: "Ask the server about the world",
    description:
      "One read-only door onto the server's view of the world; pick the subject with `domain`. "
      + "status, tick, time, gamerules and dimensions need nothing else; block, container, chunk and biome "
      + "need a position; region needs min and max (at most 32768 blocks) and answers with block counts, "
      + "plus the palette-indexed grid with cells=true and full block states with states=true; entity takes uuid or id; "
      + "entities takes limit, types, typePatterns and bounds ({min, max} or {center, radius}); performance "
      + "takes durationMs. Results are budgeted — lists say how many more there were, and NBT is only fetched "
      + "when you ask for nbt=true.",
    cap: "query",
    readOnly: true,
    idempotent: true,
    inputSchema: queryShape,
    handler: async (session, args) => runQuery(session, args),
  }),
  tool({
    name: "blockwright_record",
    title: "Record video and sound",
    description:
      "Capture a run rather than a moment. op=video.start records the client's framebuffer to an MP4 (silent; "
      + "audio: true muxes in the game's audio mix) until video.stop — the way to show a stutter, a flicker or an "
      + "animation that no single frame explains. op=sound.start collects the sound events the client plays "
      + "until sound.stop, which is how you check that something played at all, and what. video.start can move "
      + "the camera while it records: cameraPath { bounds, preset (orbit by default), presetCount, seconds } "
      + "flies through framed viewpoints around the box, or { poses, seconds } through your own; video.stop "
      + "puts the camera back on the player.",
    cap: "record",
    readOnly: false,
    inputSchema: recordShape,
    handler: runRecord,
  }),
];

export function selectTools(caps: Cap[]): ToolDefinition[] {
  const enabled = new Set<Cap>(["core", ...caps]);
  return TOOLS.filter((tool) => enabled.has(tool.cap));
}

export function parseCaps(value: string | undefined): Cap[] {
  if (value === undefined) {
    return DEFAULT_CAPS;
  }
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parsed.includes("all")) {
    return [...ALL_CAPS];
  }
  const unknown = parsed.filter((part) => !ALL_CAPS.includes(part as Cap));
  if (unknown.length > 0) {
    throw new Error(`unknown capability: ${unknown.join(", ")}; known caps are ${ALL_CAPS.join(", ")}`);
  }
  return ["core", ...(parsed as Cap[])];
}
