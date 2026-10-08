import {
  aimGeometry,
  type AimGeometry,
  type AimGeometryOptions,
  type BlockPos,
  type CallOptions,
  type Direction,
  type EntityJson,
  type ItemJson,
  type MinecraftClient,
  type MinecraftPair,
  type MinecraftServer,
  type Vec3,
} from "../core/index.js";
import { coreTask, defined } from "../core/templates.js";
import { clientTask } from "./module.js";
import type {
  HitResultJson,
  InteractionHandName,
  KeyModifiers,
  MouseButtonName,
  MouseDispatch,
  ServerRoundTrip,
} from "./types.js";

/** Actions through the player: a screen would swallow them, so the client first waits for none to be open. */
const THROUGH_PLAYER = { settle: { requireNoScreen: true } } as const;

export interface InteractionResultJson {
  /** The InteractionResult, e.g. `success`, `consume`, `pass`, `fail`. */
  result: string;
  consumed: boolean;
  hand: InteractionHandName;
  /** The server handled the interaction before this answer (a barrier round trip). */
  server: ServerRoundTrip;
}

export interface UseBlockOptions {
  /** Default `up`. */
  face?: Direction;
  hand?: InteractionHandName;
  /** Where on the block the click lands; default the centre of the face. */
  cursor?: Vec3;
  insideBlock?: boolean;
}

export interface UseBlockResult extends InteractionResultJson {
  pos: BlockPos;
  face: Direction;
  cursor: Vec3;
  /** The block's id before the use. */
  block: string;
}

const USE_BLOCK = clientTask<{ pos: BlockPos } & UseBlockOptions, UseBlockResult>("interact.useBlock",
  "return Interact.useBlock(ctx, Args.of(ctx));", THROUGH_PLAYER);

/** A right click on the block at `pos` (MultiPlayerGameMode.useItemOn), wherever the player looks. */
export function useBlock(client: MinecraftClient, pos: BlockPos, options: UseBlockOptions & CallOptions = {}): Promise<UseBlockResult> {
  const { signal, timeoutMs, ...use } = options;
  return client.run(USE_BLOCK, { pos, ...use }, defined({ signal, timeoutMs }));
}

export interface UseItemResult extends InteractionResultJson {
  /** What the hand held before the use. */
  item: ItemJson;
}

const USE_ITEM = clientTask<{ hand?: InteractionHandName }, UseItemResult>("interact.useItem",
  "return Interact.useItem(ctx, Args.of(ctx));", THROUGH_PLAYER);

/** Uses what the hand holds (MultiPlayerGameMode.useItem), as a right click in the air would. */
export function useItem(client: MinecraftClient, options: { hand?: InteractionHandName } & CallOptions = {}): Promise<UseItemResult> {
  const { signal, timeoutMs, ...use } = options;
  return client.run(USE_ITEM, use, defined({ signal, timeoutMs }));
}

export type EntityRef = { id: number } | { uuid: string };

export interface UseEntityResult extends InteractionResultJson {
  entity: EntityJson;
  point: Vec3;
  interactAt: string;
  /** The fallback `interact`'s result, when `interactAt` did not consume the action. */
  interact: string | null;
}

const USE_ENTITY = clientTask<EntityRef & { point?: Vec3; hand?: InteractionHandName }, UseEntityResult>(
  "player.useEntity", "return Interact.entity(ctx, Args.of(ctx));", THROUGH_PLAYER);

/** A right click on an entity loaded on the client: interactAt at `point` (default its centre), then interact. */
export function useEntity(
  client: MinecraftClient,
  entity: EntityRef,
  options: { point?: Vec3; hand?: InteractionHandName } & CallOptions = {},
): Promise<UseEntityResult> {
  const { signal, timeoutMs, ...use } = options;
  return client.run(USE_ENTITY, { ...entity, ...use }, defined({ signal, timeoutMs }));
}

// ---- aiming and clicking in the world ----

export interface AimOptions extends AimGeometryOptions, CallOptions {
  /** The player to move; default the first player. */
  player?: string;
  dimension?: string;
}

export interface AimResult extends AimGeometry {
  /** Where the server put the player. */
  position: Vec3;
  yaw: number;
  pitch: number;
}

// The client area has no server module: this one server step is a core template.
const AIM = coreTask<{ view: Vec3; yaw: number; pitch: number; player?: string; dimension?: string }, Omit<AimResult, keyof AimGeometry>>(
  "aimAt", `Args args = Args.of(ctx);
var found = Levels.player(ctx, args.string("player", null));
if (!(found instanceof ServerPlayer player)) throw Fail.unavailable("no such player on the server: " + args.string("player", "(first)"));
var level = Levels.serverLevel(ctx.server(), args.string("dimension", null));
var view = args.vec3("view");
player.stopRiding();
player.setDeltaMovement(Vec3.ZERO);
player.teleportTo(level, view.x, view.y, view.z, (float) args.number("yaw"), (float) args.number("pitch"));
player.setYHeadRot((float) args.number("yaw"));
return Sync.stamp(Values.obj("position", GameJson.vec(player.position()), "yaw", player.getYRot(), "pitch", player.getXRot()));`,
  { imports: ["net.minecraft.server.level.ServerPlayer", "net.minecraft.world.phys.Vec3"] },
);

/**
 * Puts the player where it aims at a face of the block at `pos` ({@link aimGeometry}: on top of it looking
 * down for `up`, else 1.5 blocks out from the face) by teleporting it on the server. The answer is stamped,
 * so the next client task first sees the move (and a rendered frame, so the crosshair target is fresh).
 */
export async function aimAt(server: MinecraftServer, pos: BlockPos, options: AimOptions = {}): Promise<AimResult> {
  const geometry = aimGeometry(pos, options);
  const moved = await server.run(AIM, {
    view: geometry.view,
    yaw: geometry.camera.yaw,
    pitch: geometry.camera.pitch,
    ...defined({ player: options.player, dimension: options.dimension }),
  }, defined({ signal: options.signal, timeoutMs: options.timeoutMs }));
  return { ...geometry, ...moved };
}

export interface ClickTargetResult {
  button: MouseButtonName;
  /** What the crosshair was on when the button went down. */
  hitResult: HitResultJson | null;
  dimension: string;
  dispatch: { press: MouseDispatch; release: MouseDispatch };
  server: ServerRoundTrip;
}

const CLICK_TARGET = clientTask<
  { button?: MouseButtonName; modifiers?: KeyModifiers; expect?: { pos: BlockPos } },
  ClickTargetResult
>("interact.click", "return Interact.clickTarget(ctx, Args.of(ctx));", THROUGH_PLAYER);

/**
 * A click of `button` (default left) at whatever the crosshair is on, as a player would (MouseHandler.onPress,
 * acted on in the next client tick); answers once the server has handled it. With `expect.pos` it first
 * checks the crosshair is on that block (else `not-found`).
 */
export function clickTarget(
  client: MinecraftClient,
  options: { button?: MouseButtonName; modifiers?: KeyModifiers; expect?: { pos: BlockPos } } & CallOptions = {},
): Promise<ClickTargetResult> {
  const { signal, timeoutMs, ...click } = options;
  return client.run(CLICK_TARGET, click, defined({ signal, timeoutMs }));
}

export interface ClickWorldOptions extends AimOptions {
  button?: MouseButtonName;
  modifiers?: KeyModifiers;
}

export interface ClickWorldResult {
  aim: AimResult;
  click: ClickTargetResult;
}

/**
 * Aims the player at a face of the block at `pos` ({@link aimAt}), then clicks it ({@link clickTarget},
 * checking the crosshair is on that block). Left breaks (instantly in creative), right uses.
 */
export async function clickWorld(
  mc: MinecraftPair,
  pos: BlockPos,
  options: ClickWorldOptions = {},
): Promise<ClickWorldResult> {
  const { button, modifiers, ...aimOptions } = options;
  const aim = await aimAt(mc.server, pos, aimOptions);
  const click = await clickTarget(mc.client, {
    ...defined({ button, modifiers, signal: options.signal, timeoutMs: options.timeoutMs }),
    expect: { pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } },
  });
  return { aim, click };
}
