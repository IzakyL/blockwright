// Test support (no tests here): fake instances and a fake launch path for the session and its tools.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Run } from "@izakyl/blockwright-client";
import type { BlockwrightInstance, InstancePair, InstanceRole, LaunchPairOptions, ModuleSpec, Output, RunEnd, TaskSpec } from "@izakyl/blockwright-client";
import { BlockwrightSession } from "./session.js";
import type { SessionOptions } from "./session.js";

export interface FakeAnswer {
  outputs?: unknown[];
  bytes?: Array<{ data: Buffer; meta?: unknown }>;
  end?: RunEnd;
}

/** A responder: the first rule whose pattern the task source matches answers. */
export type Rule = [RegExp, (task: TaskSpec) => FakeAnswer];

export class FakeGame {
  readonly instanceId: string;
  readonly role: InstanceRole;
  readonly instanceDir: string;
  readonly tracePath: string;
  readonly tasks: TaskSpec[] = [];
  readonly ensured: string[] = [];
  rules: Rule[] = [];
  closed = false;

  constructor(role: InstanceRole, dir: string, id = `fake-${role}`) {
    this.role = role;
    this.instanceId = id;
    this.instanceDir = dir;
    this.tracePath = join(dir, `${role}.ndjson`);
  }

  async ensureModules(modules: readonly ModuleSpec[]) {
    this.ensured.push(...modules.map((module) => module.name));
    return { loaded: modules.map((module) => module.name), skipped: [] };
  }

  run<T = unknown>(task: TaskSpec): Run<T> {
    this.tasks.push(task);
    const rule = this.rules.find(([pattern]) => pattern.test(task.source));
    const answer = rule ? rule[1](task) : { outputs: [null] };
    return new Run<T>((controller) => {
      queueMicrotask(() => {
        for (const value of answer.outputs ?? []) controller.output({ kind: "json", value } as Output<T>);
        for (const bytes of answer.bytes ?? []) controller.output({ kind: "bytes", data: bytes.data, meta: bytes.meta ?? null });
        controller.end(answer.end ?? { status: "ok" });
      });
      return { cancel: async () => {} };
    });
  }

  /** Tasks whose source matches. */
  ran(pattern: RegExp): TaskSpec[] {
    return this.tasks.filter((task) => pattern.test(task.source));
  }
}

export const PLAYER = {
  id: 1, uuid: "0000-1111", type: "minecraft:player", name: "Dev", dimension: "minecraft:overworld",
  position: { x: 0.5, y: -60, z: 0.5 }, rotation: { yaw: 0, pitch: 0 }, alive: true,
  health: 20, maxHealth: 20, onGround: true, selectedSlot: 0, mainHand: { id: "minecraft:air", count: 0 },
  food: 20, saturation: 5, exhaustion: 0, gameMode: "creative", eyeHeight: 1.62, vehicle: null,
};

export const STATUS = {
  tick: 100, gameTime: 50, frozen: true, sprinting: false, tickRate: 20, worlds: [], worldCount: 3,
  playerCount: 1, maxPlayers: 20, version: "1.21.1", motd: "",
};

/** Rules every pair needs: settling, observing, the server status and an empty screen. */
export function baseRules(state: { observe: () => Record<string, unknown> } = { observe: () => ({}) }): Rule[] {
  return [
    [/Settle\.settle/, () => ({ outputs: [{ serverId: "srv", epoch: 1, frames: 2, elapsedMs: 3 }] })],
    [/Observe\.observe/, () => ({ outputs: [{ screen: null, player: PLAYER, messages: [], errors: [], ...state.observe() }] })],
    [/WorldQueries\.status/, () => ({ outputs: [STATUS] })],
    [/Screens\.info\(mc\)/, () => ({ outputs: [{ p0: { ok: null } }] })],
  ];
}

export interface FakeLaunch {
  server: FakeGame;
  client: FakeGame;
  launches: LaunchPairOptions[];
  closed: number;
}

/** A session whose launch path hands out fake instances (no UI library adapters). */
export function fakeSession(options: SessionOptions = {}): { session: BlockwrightSession; fake: FakeLaunch } {
  const dir = mkdtempSync(join(tmpdir(), "bw-mcp-"));
  const fake: FakeLaunch = {
    server: new FakeGame("server", dir),
    client: new FakeGame("client", dir),
    launches: [],
    closed: 0,
  };
  fake.server.rules = baseRules();
  fake.client.rules = baseRules();
  const session = new BlockwrightSession({
    cwd: dir,
    artifactDir: join(dir, "artifacts"),
    adapters: [],
    launcher: async (launch) => {
      fake.launches.push(launch);
      return fakePair(fake);
    },
    ...options,
  });
  return { session, fake };
}

export function fakePair(fake: FakeLaunch, retried: unknown[] = []): InstancePair {
  return {
    driver: {} as InstancePair["driver"],
    server: fake.server as unknown as BlockwrightInstance,
    client: fake.client as unknown as BlockwrightInstance,
    retried,
    close: async () => {
      fake.closed += 1;
      return { server: { code: 0, success: true }, client: { code: 0, success: true } };
    },
  };
}
