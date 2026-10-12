import type { BlockwrightDriver, BlockwrightInstance, InstanceLaunchOptions } from "@izakyl/blockwright-client";
import {
  camera,
  defineTask,
  javaTask,
  minecraft,
  screen,
  world,
  type MinecraftClient,
  type MinecraftServer,
  type Vec3,
} from "@izakyl/blockwright-minecraft";
import { CINEMA } from "./module.js";

/** A client that films: the game's own, or a further one joined to the same server. */
export interface FilmCamera {
  name: string;
  client: MinecraftClient;
  /** The player this client is in the world as (the account its profile gives it). */
  player: string;
  /** The instance {@link launchCameras} started for it; absent for a client launched elsewhere. */
  instance?: BlockwrightInstance;
}

export interface FilmCameraSpec {
  name: string;
  /** The username of the account the camera's profile launches with; two cameras need two accounts. */
  player: string;
  /** How its client launches: at least a `config` naming a client profile of its own. */
  launch: InstanceLaunchOptions;
  /** How long it gets to join; default 300000. */
  readyTimeoutMs?: number;
}

export interface LaunchedCameras {
  cameras: FilmCamera[];
  /** The cameras that did not join, and why. */
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Launches further clients into the server `driver` already runs, side by side, one per spec: a camera is a
 * player of its own, so each needs a profile with its own account. A camera that does not join is closed and
 * reported in `failed` instead of failing the rest: a run is worth having from the angles that did come up.
 */
export async function launchCameras(driver: BlockwrightDriver, specs: readonly FilmCameraSpec[]): Promise<LaunchedCameras> {
  const settled = await Promise.allSettled(specs.map(async (spec): Promise<FilmCamera> => {
    const instance = await driver.launchNeoForge("client", spec.launch);
    try {
      await instance.waitForReady({ timeoutMs: spec.readyTimeoutMs ?? 300_000 });
    } catch (error) {
      await instance.close().catch(() => undefined);
      throw error;
    }
    return { name: spec.name, client: minecraft.client(instance), player: spec.player, instance };
  }));
  const cameras: FilmCamera[] = [];
  const failed: LaunchedCameras["failed"] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") cameras.push(result.value);
    else failed.push({ name: specs[index]!.name, reason: String(result.reason instanceof Error ? result.reason.message : result.reason) });
  });
  return { cameras, failed };
}

/** Closes the clients {@link launchCameras} started; never throws. */
export async function closeCameras(cameras: readonly FilmCamera[]): Promise<void> {
  await Promise.all(cameras.map((each) => each.instance?.close().catch(() => undefined)));
}

/** Where a camera stands and looks. */
export interface Stand {
  position: Vec3;
  yaw: number;
  pitch: number;
  /** Field of view, 30..110; default the game's. */
  fov?: number;
  /** Give the camera's player night vision here (a mine, a cellar); it is taken away at a stand without it. */
  nightVision?: boolean;
}

export interface StandOptions {
  /** Frames to draw from the new pose before answering; default 4. */
  settleFrames?: number;
  /**
   * Wall-clock time to wait first, for a stand far from where the camera was: the land there has to arrive
   * from the server and be built before a frame from it is worth having. Default 0.
   */
  arriveMs?: number;
}

const SETTLE_FRAMES = 4;

async function pose(film: FilmCamera, server: MinecraftServer, stand: Stand, options: StandOptions): Promise<void> {
  const { position, yaw, pitch } = stand;
  await world.tryCommand(server, stand.nightVision
    ? `effect give ${film.player} night_vision infinite 0 true`
    : `effect clear ${film.player} night_vision`);
  // The player goes too, so the server sends the land around the pose and the entities in it.
  await world.command(server, `tp ${film.player} ${position.x} ${position.y} ${position.z} ${yaw} ${pitch}`);
  await camera.set(film.client, { position, yaw, pitch, ...(stand.fov !== undefined ? { fov: stand.fov } : {}) });
  if (options.arriveMs) await new Promise((resolve) => setTimeout(resolve, options.arriveMs));
  // A client too busy to draw its frames in the settle's time has still had that time.
  await film.client.settle({ frames: options.settleFrames ?? SETTLE_FRAMES, requireNoScreen: false }).catch(() => undefined);
}

/**
 * Makes a client a camera and stands it at `stand`: its player a spectator with empty hands (nothing in frame,
 * nothing in its way), any open screen closed, the GUI hidden, the free camera at the pose. Answers once frames
 * have been drawn from there.
 */
export async function standCamera(film: FilmCamera, server: MinecraftServer, stand: Stand, options: StandOptions = {}): Promise<void> {
  await world.command(server, `gamemode spectator ${film.player}`);
  await world.tryCommand(server, `clear ${film.player}`);
  await screen.dismiss(film.client).catch(() => undefined);
  await camera.hud(film.client, false);
  await pose(film, server, stand, options);
}

/** Sends a camera that already stands ({@link standCamera}) to another pose, and answers once it has drawn from there. */
export function moveCamera(film: FilmCamera, server: MinecraftServer, stand: Stand, options: StandOptions = {}): Promise<void> {
  return pose(film, server, stand, options);
}

export interface SightBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface ClearestViewOptions {
  /** The eyes to choose among, in order of preference: the first of equals wins. */
  candidates: readonly Vec3[];
  /** The ground the subject covers. */
  subject: SightBox;
  /** The height the subject is looked at. */
  y: number;
  dimension?: string;
}

export interface ClearestView {
  /** The candidate that sees most of the subject; -1 without candidates. */
  index: number;
  /** The sight lines it got through, of `of` cast. */
  visible: number;
  of: number;
  /** Every candidate's count, in order. */
  seen: number[];
}

const CLEAREST = defineTask<ClearestViewOptions, ClearestView>({
  name: "cinema.clearestView",
  side: "server",
  modules: [CINEMA],
  source: javaTask({ imports: ["blockwright.cinema.*"], body: "return Sight.clearest(ctx, Args.of(ctx));" }),
});

/**
 * Of several places to shoot a subject from, the one that sees most of it through the blocks standing now
 * (a grid of sight lines cast in the game, in one task). A pose worked out on paper can be behind a roof once
 * the world is built; pick among alternatives with this before shooting.
 */
export function clearestView(server: MinecraftServer, options: ClearestViewOptions): Promise<ClearestView> {
  const { candidates, subject, y, dimension } = options;
  return server.run(CLEAREST, { candidates: [...candidates], subject, y, ...(dimension !== undefined ? { dimension } : {}) });
}
