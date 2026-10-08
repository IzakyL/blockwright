import { BlockwrightRunError, type InstanceRole, type Run } from "@izakyl/blockwright-client";
import { MinecraftTaskError, toMinecraftError, type TaskErrorContext } from "./errors.js";
import type { GameInstance } from "./instance.js";
import { coreModules, loadOrder, type PrefabModule } from "./modules.js";
import { defaultSyncLedger, unstamp, type SettleOptions, type SettleResult, type SyncLedger, type SyncMark } from "./sync.js";
import type { TaskTemplate, TemplateSettle } from "./task.js";
import { coreClientTask } from "./templates.js";
import { waitUntil, type WaitSpec, type WaitResult } from "./wait.js";

export interface MinecraftOptions {
  /** Where sync marks are kept; default the process-wide ledger (right for almost everyone). */
  sync?: SyncLedger;
}

/** What every prefab call takes last: a signal and a deadline. */
export interface CallOptions {
  /** Aborting cancels the run. */
  signal?: AbortSignal;
  /** The call's deadline (for a wait: its in-game budget). */
  timeoutMs?: number;
}

export interface RunTemplateOptions extends CallOptions {
  /** Called with each `{"$progress": p}` output's `p` (see Wait.java); those outputs are not answers. */
  onProgress?: (progress: unknown) => void;
}

/** A template's arguments as a parameter list: none for `void`, else one. */
export type TemplateArgs<A> = [A] extends [void] ? [args?: undefined, options?: RunTemplateOptions] : [args: A, options?: RunTemplateOptions];

const PROGRESS_KEY = "$progress";

/**
 * The prefab bound to one instance: it loads the prefab's modules there on first use (and again after a
 * reconnect), runs task templates, and applies the sync policy. Area features are the namespaces' functions
 * (`world.block(server, pos)`), taking a {@link MinecraftServer} or {@link MinecraftClient}.
 */
export abstract class MinecraftInstance {
  readonly instance: GameInstance;
  readonly role: InstanceRole;
  readonly sync: SyncLedger;

  protected constructor(instance: GameInstance, role: InstanceRole, options: MinecraftOptions = {}) {
    if (instance.role !== role) {
      throw new TypeError(`instance ${instance.instanceId} is a ${instance.role}, not a ${role}`);
    }
    this.instance = instance;
    this.role = role;
    this.sync = options.sync ?? defaultSyncLedger;
  }

  get instanceId(): string {
    return this.instance.instanceId;
  }

  /** Loads the core modules for this side and `modules` (with what they require), each once per connection. */
  async ensure(...modules: PrefabModule[]): Promise<void> {
    const ordered = loadOrder([...coreModules(this.role), ...modules], this.role);
    await this.instance.ensureModules(ordered.map((module) => module.spec()));
  }

  /**
   * Runs `template` and answers its parsed last JSON output. A stamped answer's sync mark is recorded
   * (see sync.ts); a client first settles to pending marks unless the template opts out.
   */
  async run<A, R>(template: TaskTemplate<A, R>, ...[args, options = {}]: TemplateArgs<A>): Promise<R> {
    const context = this.#context(template);
    const run = await this.start(template, ...([args, options] as TemplateArgs<A>));
    let answer: unknown;
    let found = false;
    try {
      for await (const output of run) {
        if (output.kind !== "json") continue;
        const value = output.value;
        if (value !== null && typeof value === "object" && PROGRESS_KEY in value && Object.keys(value).length === 1) {
          options.onProgress?.((value as Record<string, unknown>)[PROGRESS_KEY]);
          continue;
        }
        answer = value;
        found = true;
      }
    } catch (error) {
      throw toMinecraftError(error, context);
    }
    if (!found && template.requiresOutput !== false) {
      throw new MinecraftTaskError(context, new BlockwrightRunError({ status: "ok" }));
    }
    const { value, mark } = unstamp(answer);
    if (mark) this.sync.record(mark);
    return template.parse ? template.parse(value, args as A) : (value as R);
  }

  /**
   * Starts `template` after loading its modules (and settling, on a client) and hands back the raw
   * {@link Run}: for tasks that stream (binary frames, many records). The caller consumes it; errors from
   * it are the client's {@link BlockwrightRunError} (wrap with {@link toMinecraftError} if wanted).
   */
  async start<A, R>(template: TaskTemplate<A, R>, ...[args, options = {}]: TemplateArgs<A>): Promise<Run> {
    this.#checkSide(template);
    await this.ensure(...(template.modules ?? []));
    if (this.role === "client" && template.settle !== false) {
      await this.autoSettle(template.settle ?? {});
    }
    const timeoutMs = options.timeoutMs ?? template.timeoutMs;
    return this.instance.run({
      source: template.source,
      thread: template.thread ?? (this.role === "client" ? "client" : "server"),
      args: args ?? {},
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(template.limits ? { limits: template.limits } : {}),
    }, options.signal ? { signal: options.signal } : {});
  }

  /** Waits in the game until a Java condition holds; see {@link WaitSpec}. */
  waitUntil<T = unknown>(spec: WaitSpec): Promise<WaitResult<T>> {
    return waitUntil<T>(this, spec);
  }

  /** Client side of the sync policy; a no-op on servers. */
  protected async autoSettle(_settle: TemplateSettle): Promise<void> {}

  #checkSide(template: TaskTemplate<any, any>): void {
    if (template.side !== "any" && template.side !== this.role) {
      throw new TypeError(`${template.name} runs on a ${template.side}, and ${this.instanceId} is a ${this.role}`);
    }
  }

  #context(template: TaskTemplate<any, any>): TaskErrorContext {
    return { task: template.name, instanceId: this.instanceId, role: this.role };
  }
}

export class MinecraftServer extends MinecraftInstance {
  constructor(instance: GameInstance, options: MinecraftOptions = {}) {
    super(instance, "server", options);
  }
}

const SETTLE = coreClientTask<{ marks: SyncMark[] } & SettleOptions, Omit<SettleResult, "marks">>("settle", "Settle.settle", {
  settle: false,
});

const SETTLE_TIMEOUT_MS = 5_000;

export class MinecraftClient extends MinecraftInstance {
  constructor(instance: GameInstance, options: MinecraftOptions = {}) {
    super(instance, "client", options);
  }

  /**
   * Settles this client explicitly: every pending server mark received, a barrier round trip through its
   * server (default on), one more rendered frame, and (default on) no screen open.
   */
  async settle(options: SettleOptions = {}): Promise<SettleResult> {
    return this.#settle(this.sync.pending(this.instance), {
      barrier: true,
      requireNoScreen: true,
      ...options,
    });
  }

  protected override async autoSettle(settle: TemplateSettle): Promise<void> {
    const pending = this.sync.pending(this.instance);
    if (pending.length === 0) return;
    await this.#settle(pending, { requireNoScreen: settle.requireNoScreen ?? false });
  }

  async #settle(marks: SyncMark[], options: SettleOptions): Promise<SettleResult> {
    const timeoutMs = options.timeoutMs ?? SETTLE_TIMEOUT_MS;
    const result = await this.run(SETTLE, { ...options, timeoutMs, marks }, { timeoutMs: timeoutMs + 5_000 });
    this.sync.settled(this.instance, marks);
    return { ...result, marks };
  }
}

export interface MinecraftPair {
  server: MinecraftServer;
  client: MinecraftClient;
}

const servers = new WeakMap<GameInstance, MinecraftServer>();
const clients = new WeakMap<GameInstance, MinecraftClient>();

function serverOf(instance: GameInstance, options?: MinecraftOptions): MinecraftServer {
  if (options?.sync) return new MinecraftServer(instance, options);
  let handle = servers.get(instance);
  if (!handle) servers.set(instance, (handle = new MinecraftServer(instance)));
  return handle;
}

function clientOf(instance: GameInstance, options?: MinecraftOptions): MinecraftClient {
  if (options?.sync) return new MinecraftClient(instance, options);
  let handle = clients.get(instance);
  if (!handle) clients.set(instance, (handle = new MinecraftClient(instance)));
  return handle;
}

/**
 * The prefab bound to a launched pair: `const mc = minecraft(pair)`, then `mc.server` / `mc.client`.
 * Handles are cached per instance (unless given their own sync ledger), so calling this again is cheap.
 */
export function minecraft(pair: { server: GameInstance; client: GameInstance }, options?: MinecraftOptions): MinecraftPair {
  return { server: serverOf(pair.server, options), client: clientOf(pair.client, options) };
}

/** The prefab bound to one server instance. */
minecraft.server = serverOf;
/** The prefab bound to one client instance. */
minecraft.client = clientOf;
