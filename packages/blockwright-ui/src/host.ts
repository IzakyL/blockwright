import { errorSummary } from "@izakyl/blockwright-client";
import { centre } from "./contract.js";
import type {
  AnyUiAdapter,
  Point,
  UiAction,
  UiActOutcome,
  UiCallOptions,
  UiCodegen,
  UiLayer,
  UiNode,
  UiPlatform,
  UiProbeOutcome,
  UiSelector,
  UiWaitState,
} from "./contract.js";

export interface RefEntry {
  adapter: string;
  key: string;
  selector: UiSelector;
  /** The selector is positional and may point elsewhere after the UI changes. */
  fragile: boolean;
}

export interface UiView {
  /** Bottom to top in adapter order: a later adapter draws over an earlier one. */
  layers: UiLayer[];
  refOf: Map<UiNode, string>;
  /** Adapters that could not read a screen that is theirs. */
  errors: string[];
}

/** What an action can point at: a ref from a read, a selector for a named adapter, or a GUI point. */
export type UiTarget =
  | { ref: string }
  | { adapter: string; selector: UiSelector }
  | { x: number; y: number };

export type UiElementTarget = Exclude<UiTarget, { x: number }>;

export interface UiActResult extends UiActOutcome {
  /** The ref entry (or the adapter and selector) acted on; absent for a bare point. */
  entry?: RefEntry;
}

export interface UiReadRun<Probe> {
  /** Every active adapter's probes, namespaced `ui:<adapter>:<name>`: run them in one in-game task. */
  probes: Record<string, Probe>;
  /** Parse what they answered (extra outcomes are ignored; missing ones read as absent). */
  finish(outcomes: Readonly<Record<string, UiProbeOutcome>>): UiView;
}

const PROBE_PREFIX = "ui:";

/** Minecraft reads two presses of one button on one spot within 250ms as a double click. */
const DOUBLE_CLICK_MS = 300;
const DEFAULT_WAIT_MS = 10_000;

export interface UiHostOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface LastClick {
  target: string;
  button: string;
  at: number;
}

type PointAction = Exclude<UiAction, { kind: "scrollIntoView" }>;

/**
 * Reads, acts on and waits for whatever UI the adapters recognise, through one platform. It hands out
 * refs (`e1`, `e2`, ...) that stick to an adapter's node key across reads, so an agent or a recorder can
 * name what it saw, and turns acted-on refs back into replayable code.
 */
export class UiHost<Client = unknown, Probe = unknown> {
  private readonly platform: UiPlatform<Client, Probe>;
  private readonly all: AnyUiAdapter<Client, Probe>[];
  private disabled = new Map<string, string>();
  private refs = new Map<string, RefEntry>();
  private refByKey = new Map<string, string>();
  private last?: UiView;
  private lastClick?: LastClick;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(platform: UiPlatform<Client, Probe>, adapters: readonly AnyUiAdapter<Client, Probe>[], options: UiHostOptions = {}) {
    this.platform = platform;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const ids = new Set<string>();
    for (const adapter of adapters) {
      if (ids.has(adapter.id)) {
        throw new Error(`two ui adapters are both called ${adapter.id}`);
      }
      ids.add(adapter.id);
    }
    this.all = [...adapters];
  }

  /** Adapters in use, with the reason for any that were turned off. */
  adapters(): Array<{ id: string; summary: string; off?: string }> {
    return this.all.map((adapter) => ({
      id: adapter.id,
      summary: adapter.summary,
      ...(this.disabled.has(adapter.id) ? { off: this.disabled.get(adapter.id) } : {}),
    }));
  }

  /** Forget refs and the last read, e.g. when the client restarts. */
  reset(): void {
    this.refs.clear();
    this.refByKey.clear();
    this.last = undefined;
    this.lastClick = undefined;
  }

  /** Turn off adapters this build cannot serve, once per launch; answers a note per adapter turned off. */
  async verify(client: Client, options: UiCallOptions = {}): Promise<string[]> {
    this.disabled.clear();
    const notes: string[] = [];
    for (const adapter of this.all) {
      if (!adapter.verify) {
        continue;
      }
      try {
        const reason = await adapter.verify(client, options);
        if (reason !== undefined) {
          this.disabled.set(adapter.id, reason);
        }
      } catch (error) {
        this.disabled.set(adapter.id, `check failed: ${errorSummary(error)}`);
      }
      const off = this.disabled.get(adapter.id);
      if (off !== undefined) {
        notes.push(`ui adapter ${adapter.id} is off: ${off}`);
      }
    }
    return notes;
  }

  private active(): AnyUiAdapter<Client, Probe>[] {
    return this.all.filter((adapter) => !this.disabled.has(adapter.id));
  }

  /** Every active adapter's probes and the parser for their answers, for a caller running them itself. */
  plan(): UiReadRun<Probe> {
    const plans = this.active().map((adapter) => ({ adapter, plan: adapter.read() }));
    const probes: Record<string, Probe> = {};
    for (const { adapter, plan } of plans) {
      for (const [name, probe] of Object.entries(plan.probes)) {
        probes[`${PROBE_PREFIX}${adapter.id}:${name}`] = probe;
      }
    }
    return {
      probes,
      finish: (outcomes) => {
        const errors: string[] = [];
        const layers: UiLayer[] = [];
        for (const { adapter, plan } of plans) {
          const prefix = `${PROBE_PREFIX}${adapter.id}:`;
          const mine: Record<string, UiProbeOutcome> = {};
          for (const [name, outcome] of Object.entries(outcomes)) {
            if (name.startsWith(prefix)) {
              mine[name.slice(prefix.length)] = outcome;
            }
          }
          try {
            const layer = plan.parse(mine);
            if (layer) {
              layers.push(layer as UiLayer);
            }
          } catch (error) {
            errors.push(`${adapter.id}: ${errorSummary(error)}`);
          }
        }
        return this.index(layers, errors);
      },
    };
  }

  /** Reads the screen through every active adapter: one in-game task. */
  async read(client: Client, options: UiCallOptions = {}): Promise<UiView> {
    const { probes, finish } = this.plan();
    if (Object.keys(probes).length === 0) {
      return finish({});
    }
    return finish(await this.platform.read(client, probes, options));
  }

  private index(layers: UiLayer[], errors: string[]): UiView {
    for (const [at, layer] of layers.entries()) {
      const above = layers.slice(at + 1).filter((upper) => upper.supersedes !== undefined);
      if (above.length === 0) {
        continue;
      }
      const keep = (nodes: UiNode[]): UiNode[] => nodes
        .filter((node) => !above.some((upper) => upper.supersedes!(layer.adapter, node)))
        .map((node) => ({ ...node, children: keep(node.children) }));
      layer.roots = keep(layer.roots);
    }
    markBlocked(layers);
    // Refs stick to (adapter, key), so a ref handed out earlier still means the same thing after a
    // re-read; the selector behind it is refreshed each time the node is seen.
    const refOf = new Map<UiNode, string>();
    for (const layer of layers) {
      const adapter = this.adapter(layer.adapter);
      const visit = (node: UiNode) => {
        if (addressable(node)) {
          const identity = `${layer.adapter}\u0000${node.key}`;
          let ref = this.refByKey.get(identity);
          if (ref === undefined) {
            ref = `e${this.refByKey.size + 1}`;
            this.refByKey.set(identity, ref);
          }
          this.refs.set(ref, { adapter: adapter.id, key: node.key, ...adapter.locate(layer, node) });
          refOf.set(node, ref);
        }
        node.children.forEach(visit);
      };
      layer.roots.forEach(visit);
    }
    const view = { layers, refOf, errors };
    this.last = view;
    return view;
  }

  entry(ref: string): RefEntry {
    const entry = this.refs.get(ref);
    if (!entry) {
      throw new Error(`ref ${ref} was never handed out; read the ui to get refs`);
    }
    return entry;
  }

  async act(
    client: Client,
    target: UiTarget,
    action: UiAction,
    options: UiCallOptions & { force?: boolean } = {},
  ): Promise<UiActResult> {
    if ("x" in target) {
      if (action.kind === "scrollIntoView") {
        throw new Error("scrollIntoView needs an element, not a point");
      }
      return this.point(client, { x: target.x, y: target.y }, action, options, `point:${Math.round(target.x)},${Math.round(target.y)}`);
    }
    const entry = this.resolve(target);
    const adapter = this.usable(entry.adapter);
    const seen = this.find(entry);
    if (seen?.states.blockedBy !== undefined && !options.force) {
      throw new Error(
        `${adapter.id} ${JSON.stringify(entry.selector)} is drawn over ${seen.states.blockedBy}, and a click there `
          + "goes to that slot instead; pass force to try anyway",
      );
    }
    const identity = `${adapter.id}\u0000${JSON.stringify(entry.selector)}`;
    if (action.kind === "click" && !action.double) {
      await this.spaceOut(identity, action.button ?? "left");
    }
    const done = adapter.act ? await adapter.act(client, entry.selector, action, options) : undefined;
    if (done) {
      if (action.kind === "click") {
        this.clicked(identity, action);
      }
      return { ...done, entry };
    }
    // The adapter leaves this one to the pointer: aim at what is drawn, on a fresh read.
    const view = await this.read(client, options);
    const layer = view.layers.find((each) => each.adapter === adapter.id);
    const node = layer && adapter.match(layer, entry.selector);
    if (!node) {
      throw new Error(`nothing on screen matches ${adapter.id} ${JSON.stringify(entry.selector)}`);
    }
    if (!node.visibleBounds || !node.states.visible) {
      throw new Error(`${adapter.id} ${JSON.stringify(entry.selector)} is not drawn, so there is nowhere to aim`);
    }
    const at = centre(node.visibleBounds);
    const label = node.name ?? node.key;
    if (action.kind === "scrollIntoView") {
      return { summary: `${label} is already drawn, at ${Math.round(at.x)},${Math.round(at.y)}`, point: at, entry };
    }
    const result = await this.point(client, at, action, options, identity);
    return { ...result, summary: `${result.summary} (${label})`, entry };
  }

  /**
   * Waits in the game — one task, decided there — until a target is actionable or absent. Running out of
   * budget throws {@link UiWaitTimeoutError}.
   */
  async waitFor(
    client: Client,
    target: UiElementTarget,
    state: UiWaitState,
    options: UiCallOptions = {},
  ): Promise<{ elapsedMs: number }> {
    const entry = this.resolve(target);
    const adapter = this.usable(entry.adapter);
    const last = this.last?.layers.find((layer) => layer.adapter === adapter.id);
    return adapter.wait(client, entry.selector, state, {
      ...options,
      timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_MS,
      ...(last ? { last } : {}),
    });
  }

  /** The statement for a recorded action, falling back to the pointer at `point` when no adapter can name it. */
  codegen(
    entry: Pick<RefEntry, "adapter" | "selector" | "fragile"> | undefined,
    action: UiAction,
    point: Point | undefined,
  ): (UiCodegen & { warning?: string }) | undefined {
    const adapter = entry && this.all.find((each) => each.id === entry.adapter);
    const generated = adapter && entry && adapter.codegen(entry.selector, action);
    if (generated) {
      return entry.fragile
        ? { ...generated, warning: `positional selector ${JSON.stringify(entry.selector)}` }
        : generated;
    }
    if (!point || action.kind === "scrollIntoView") {
      return undefined;
    }
    const fallback = this.platform.pointCodegen(point, action);
    return fallback && { ...fallback, warning: "raw coordinates" };
  }

  private async point(client: Client, at: Point, action: PointAction, options: UiCallOptions, identity: string): Promise<UiActResult> {
    if (action.kind === "click" && !action.double) {
      await this.spaceOut(identity, action.button ?? "left");
    }
    const result = await this.platform.point(client, at, action, options);
    if (action.kind === "click") {
      this.clicked(identity, action);
    }
    return result;
  }

  private resolve(target: UiElementTarget): RefEntry {
    return "ref" in target
      ? this.entry(target.ref)
      : { adapter: target.adapter, key: "", selector: target.selector, fragile: false };
  }

  private usable(id: string): AnyUiAdapter<Client, Probe> {
    const adapter = this.adapter(id);
    const off = this.disabled.get(adapter.id);
    if (off !== undefined) {
      throw new Error(`ui adapter ${adapter.id} is off: ${off}`);
    }
    return adapter;
  }

  /** Two single clicks on one target stay two clicks: the second waits out the double-click window. */
  private async spaceOut(target: string, button: string): Promise<void> {
    const last = this.lastClick;
    if (!last || last.target !== target || last.button !== button) {
      return;
    }
    const wait = last.at + DOUBLE_CLICK_MS - this.now();
    if (wait > 0) {
      await this.sleep(wait);
    }
  }

  private clicked(target: string, action: Extract<UiAction, { kind: "click" }>): void {
    this.lastClick = { target, button: action.button ?? "left", at: this.now() };
  }

  private find(entry: Pick<RefEntry, "adapter" | "selector">): UiNode | undefined {
    const layer = this.last?.layers.find((each) => each.adapter === entry.adapter);
    return layer && this.adapter(entry.adapter).match(layer, entry.selector);
  }

  private adapter(id: string): AnyUiAdapter<Client, Probe> {
    const found = this.all.find((adapter) => adapter.id === id);
    if (!found) {
      throw new Error(`no ui adapter called ${id}; loaded: ${this.all.map((adapter) => adapter.id).join(", ")}`);
    }
    return found;
  }
}

/**
 * A container screen hit-tests its own slots before anything a library draws over them, so a slot
 * element laid over a lower layer's slot never gets the click (seen with a UI library's panel
 * beside a vanilla chest).
 */
function markBlocked(layers: UiLayer[]): void {
  const lower: Array<{ adapter: string; node: UiNode }> = [];
  for (const layer of layers) {
    const slots: Array<{ adapter: string; node: UiNode }> = [];
    const visit = (node: UiNode) => {
      if (node.role === "slot" && node.states.visible && node.visibleBounds) {
        const point = centre(node.visibleBounds);
        const under = lower.find(({ node: below }) => contains(below.visibleBounds!, point));
        if (under) {
          node.states = {
            ...node.states,
            hittable: false,
            blockedBy: `${under.adapter} ${under.node.key}${under.node.item ? ` (${under.node.item.id})` : ""}`,
          };
        }
        slots.push({ adapter: layer.adapter, node });
      }
      node.children.forEach(visit);
    };
    layer.roots.forEach(visit);
    lower.push(...slots.filter(({ node }) => node.states.hittable));
  }
}

function contains(rect: { x: number; y: number; width: number; height: number }, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

function addressable(node: UiNode): boolean {
  return node.states.visible && node.visibleBounds !== undefined
    && (node.role !== "unknown" || node.name !== undefined);
}
