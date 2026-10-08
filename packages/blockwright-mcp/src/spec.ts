import type { InstanceRole } from "@izakyl/blockwright-client";
import type { CameraPose } from "@izakyl/blockwright-minecraft";
import type { UiCodegen } from "@izakyl/blockwright-ui";

/** How a screen action replays: the adapter's statement, or nothing when it cannot be replayed. */
export type RecordedCode = UiCodegen & { warning?: string };

/** A module a task loaded first: its source root and package (as `readModuleDir` reads it). */
export interface RecordedModule {
  root: string;
  package: string;
  recursive?: boolean;
}

export type RecordedStep =
  | { kind: "launch"; config?: string }
  | { kind: "command"; command: string; succeeded: boolean }
  | {
    kind: "task";
    role: InstanceRole;
    source: string;
    args?: Record<string, unknown>;
    thread?: "server" | "client" | "worker";
    modules?: RecordedModule[];
    succeeded: boolean;
  }
  | { kind: "ui"; summary: string; code?: RecordedCode }
  | { kind: "key"; keybind: string; action: "tap" | "press" | "release" }
  | { kind: "type"; text: string }
  | { kind: "freeze"; frozen: boolean }
  | { kind: "ticks"; ticks: number }
  | { kind: "until-command"; command: string; maxTicks: number; stepTicks?: number }
  | { kind: "look"; yaw: number; pitch: number }
  | { kind: "screenshot"; label: string; cameras: Array<CameraPose & { label?: string }> };

export interface SpecInput {
  name: string;
  config?: string;
  steps: RecordedStep[];
}

export function describeStep(step: RecordedStep): string {
  switch (step.kind) {
    case "launch":
      return "launch";
    case "command":
      return `/${step.command}${step.succeeded ? "" : " (did not succeed)"}`;
    case "task":
      return `task on the ${step.role}${step.succeeded ? "" : " (did not succeed)"}`;
    case "ui":
      return `${step.summary}${step.code === undefined ? " (not replayable)" : step.code.warning ? ` (${step.code.warning})` : ""}`;
    case "key":
      return `${step.action} ${step.keybind}`;
    case "type":
      return `type ${JSON.stringify(step.text)}`;
    case "freeze":
      return step.frozen ? "freeze ticks" : "run ticks";
    case "ticks":
      return `advance ${step.ticks} ticks`;
    case "until-command":
      return `tick until ${step.command} (max ${step.maxTicks})`;
    case "look":
      return `look yaw ${step.yaw} pitch ${step.pitch}`;
    case "screenshot":
      return `screenshot ${step.label} (${Math.max(1, step.cameras.length)} view${step.cameras.length > 1 ? "s" : ""})`;
  }
}

const TEST = "@izakyl/blockwright-test";
const MINECRAFT = "@izakyl/blockwright-minecraft";
const CLIENT = "@izakyl/blockwright-client";

/**
 * A Playwright spec replaying the steps: `createGameTest` fixtures (`server`, `client` prefab handles) from
 * @izakyl/blockwright-test and @izakyl/blockwright-minecraft's namespaces; screen actions are each UI adapter's own statement.
 */
export function renderSpec(input: SpecInput): string {
  const modules = new Map<string, Set<string>>();
  const use = (from: string, ...names: string[]) => {
    const set = modules.get(from) ?? new Set<string>();
    names.forEach((name) => set.add(name));
    modules.set(from, set);
  };
  let shotIndex = 0;
  let taskIndex = 0;
  const body: string[] = [];

  for (const step of input.steps) {
    switch (step.kind) {
      case "launch":
        break;
      case "command":
        use(MINECRAFT, "world");
        body.push(step.succeeded
          ? `await world.command(server, ${literal(step.command)});`
          : `await world.command(server, ${literal(step.command)}, { allowFailure: true });`);
        break;
      case "task": {
        taskIndex += 1;
        use(MINECRAFT, "defineTask");
        const handle = step.role;
        const modules = (step.modules ?? []).map((module) => {
          use(MINECRAFT, "defineModule");
          return `defineModule(${literal(module.package)}, { root: ${literal(module.root)}${module.recursive ? ", recursive: true" : ""} })`;
        });
        const template = [
          `name: ${literal(`task ${taskIndex}`)}`,
          `side: ${literal(step.role)}`,
          ...(step.thread ? [`thread: ${literal(step.thread)}`] : []),
          ...(modules.length > 0 ? [`modules: [${modules.join(", ")}]`] : []),
          "requiresOutput: false",
          `source: ${javaLiteral(step.source)}`,
        ].join(", ");
        const statements = [step.args !== undefined
          ? `await ${handle}.run(defineTask<Record<string, unknown>, unknown>({ ${template} }), ${literal(step.args)});`
          : `await ${handle}.run(defineTask({ ${template} }));`];
        if (step.succeeded) {
          body.push(...statements);
        } else {
          // Replaying a task that failed would fail the spec; it stays visible, commented out.
          body.push("// did not succeed when recorded:", ...statements.map((statement) => statement.split("\n").map((line) => `// ${line}`).join("\n")));
        }
        break;
      }
      case "ui":
        if (step.code === undefined) {
          body.push(`// ${step.summary}: no adapter or point to replay it from`);
          break;
        }
        for (const { from, names } of step.code.imports) use(from, ...names);
        if (step.code.warning !== undefined) body.push(`// ${step.code.warning}: may need a sturdier selector`);
        body.push(step.code.code);
        break;
      case "key":
        use(MINECRAFT, "input");
        body.push(step.action === "tap"
          ? `await input.key(client, { keybind: ${literal(step.keybind)} });`
          : `await input.key(client, { keybind: ${literal(step.keybind)}, action: ${literal(step.action)} });`);
        break;
      case "type":
        use(MINECRAFT, "input");
        body.push(`await input.key(client, { text: ${literal(step.text)} });`);
        break;
      case "freeze":
        use(MINECRAFT, "tick");
        body.push(`await tick.freeze(server, ${step.frozen});`);
        break;
      case "ticks":
        use(MINECRAFT, "tick");
        body.push(`await tick.sprint(server, ${step.ticks});`);
        break;
      case "until-command":
        use(MINECRAFT, "world");
        body.push(`await world.waitFor(server, ${literal(step.command)}, ${literal(waitOptions(step))});`);
        break;
      case "look":
        use(MINECRAFT, "player");
        body.push(`await player.place(client, { yaw: ${step.yaw}, pitch: ${step.pitch} });`);
        break;
      case "screenshot": {
        shotIndex += 1;
        use(MINECRAFT, "media");
        const views = step.cameras.length === 0 ? [undefined] : step.cameras;
        views.forEach((camera, index) => {
          const view = camera?.label ?? (views.length === 1 ? step.label : String(index + 1));
          const file = `${String(shotIndex).padStart(2, "0")}-${views.length === 1 ? step.label : `${step.label}-${view}`}.png`;
          const pose = camera === undefined ? "" : `, camera: ${literal(stripLabel(camera))}`;
          body.push(`await media.screenshot(client, { path: test.info().outputPath(${literal(file)})${pose} });`);
        });
        break;
      }
    }
  }

  const options: Record<string, unknown> = {};
  if (input.config !== undefined) options.config = input.config;

  const lines: string[] = [`import { createGameTest } from ${JSON.stringify(TEST)};`];
  const rank = (from: string) => (from === CLIENT ? 0 : from === MINECRAFT ? 1 : 2);
  for (const from of [...modules.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    lines.push(`import { ${[...modules.get(from)!].sort().join(", ")} } from ${JSON.stringify(from)};`);
  }
  lines.push("", `const test = createGameTest(${literal(options, "")});`, "");
  lines.push(`test(${literal(input.name, "")}, async ({ server, client }) => {`);
  for (const line of body) {
    lines.push(...line.split("\n").map((part) => (part.length > 0 ? `  ${part}` : part)));
  }
  lines.push("});", "");
  return lines.join("\n");
}

function waitOptions(step: { maxTicks: number; stepTicks?: number }): Record<string, number> {
  return { maxTicks: step.maxTicks, ...(step.stepTicks !== undefined ? { stepTicks: step.stepTicks } : {}) };
}

function stripLabel(camera: CameraPose & { label?: string }): CameraPose {
  const { label: _label, ...pose } = camera;
  return pose;
}

/** Java source as a template literal, readable in the spec. */
function javaLiteral(source: string): string {
  return `\`${source.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

function literal(value: unknown, indent = "  "): string {
  return toLiteral(value, indent);
}

function toLiteral(value: unknown, indent: string): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    const inline = `[${value.map((item) => toLiteral(item, indent)).join(", ")}]`;
    return inline.length <= 100 ? inline : `[\n${value.map((item) => `${indent}  ${toLiteral(item, `${indent}  `)}`).join(",\n")},\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return "{}";
    const render = (key: string, item: unknown, nested: string) =>
      `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)}: ${toLiteral(item, nested)}`;
    const inline = `{ ${entries.map(([key, item]) => render(key, item, indent)).join(", ")} }`;
    return inline.length <= 100
      ? inline
      : `{\n${entries.map(([key, item]) => `${indent}  ${render(key, item, `${indent}  `)}`).join(",\n")},\n${indent}}`;
  }
  return JSON.stringify(value);
}
