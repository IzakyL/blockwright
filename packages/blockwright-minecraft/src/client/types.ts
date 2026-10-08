/** JSON shapes the client area's Java answers with (blockwright.minecraft.client.*). Keep the two in step. */
import type { BlockPos, EntityJson, ItemJson, PlayerJson, ReflectQueryResult, Vec3 } from "../core/index.js";

export type MouseButtonName = "left" | "right" | "middle";
/** GLFW modifier bits (shift 1, ctrl 2, alt 4, super 8) or their names. */
export type KeyModifiers = number | Array<"shift" | "ctrl" | "alt" | "super">;
export type InteractionHandName = "main-hand" | "off-hand";

/** What a dispatched mouse button went through (InputWitness.java). */
export interface MouseDispatch {
  /** A mod cancelled the raw mouse event. */
  preCanceled: boolean;
  postSent: boolean;
  /** A screen was open and got the event. */
  screenBranch: boolean;
  screenHandled: boolean;
  /** No screen, not cancelled: the keybind state (attack, use, ...) was updated. */
  vanillaStateUpdated: boolean;
}

/** Mouse.cursor: GUI-scaled x/y, raw pixels and the window's sizes. */
export interface CursorPosition {
  x: number;
  y: number;
  rawX: number;
  rawY: number;
  screenWidth: number;
  screenHeight: number;
  guiScaledWidth: number;
  guiScaledHeight: number;
  guiScale: number;
}

export interface MouseButtonResult {
  button: string;
  action: "press" | "release";
  modifiers: number;
  screen: string | null;
  screenAfter: string | null;
  dispatch: MouseDispatch;
  /** The `observe` query, read right after dispatch. */
  observed?: ReflectQueryResult;
}

export interface ClickResult {
  x: number;
  y: number;
  button: string;
  clicks: number;
  cursor: CursorPosition;
  /** The screen the click went to; null when none was open (the click then acted through keybinds). */
  screen: string | null;
  screenAfter: string | null;
  dispatch: Array<{ press: MouseDispatch; release: MouseDispatch }>;
}

export interface ScreenClickResult {
  handled: boolean;
  /** The screen did not take the click, so the handle's button was pressed directly. */
  pressedButton: boolean;
  x: number;
  y: number;
  button: string;
  screen: string;
  screenAfter: string | null;
}

export interface DismissResult {
  closed: true;
  /** Whether any ESC was sent (false: nothing was open, or it closed by itself). */
  dismissed: boolean;
  initialScreen: string | null;
  escapes: number;
  elapsedMs: number;
}

/** Screens.info */
export interface ScreenInfo {
  className: string;
  superClassName: string;
  title: string;
  width: number;
  height: number;
  closesOnEsc: boolean;
  pauses: boolean;
  /** An AbstractContainerScreen (it has slots). */
  container: boolean;
  menu?: string;
  left?: number;
  top?: number;
}

/** One of the open screen's widgets (a direct child), GUI-scaled. */
export interface ScreenWidget {
  /** The label, else the tooltip, else `className#index`. */
  id: string;
  label?: string;
  tooltip?: string;
  value?: string;
  className: string;
  /** Says more than an anonymous class name like `ChatScreen$1`. */
  superClassName?: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  handle?: string;
}

/** One slot of the open container screen's menu, at its icon's top-left corner. */
export interface ScreenSlot {
  index: number;
  x: number;
  y: number;
  width: 16;
  height: 16;
  item?: ItemJson;
  /** Slot.isActive(); an inactive slot is neither drawn nor clickable. */
  active: boolean;
  handle?: string;
}

/**
 * Picks a widget: `index` narrows first, then the first given of `id`, `label`, `tooltip`, `className`
 * (substring) or `idPattern`, `labelPattern` (anchored glob, `*` the only wildcard) picks the first match.
 */
export interface WidgetSelector {
  id?: string;
  idPattern?: string;
  label?: string;
  labelPattern?: string;
  tooltip?: string;
  className?: string;
  index?: number;
}

export type WidgetState = "actionable" | "present" | "absent";

export interface HudTextEntry {
  text: string;
  remainingTicks: number;
}

export interface HudText {
  actionBar: HudTextEntry | null;
  title: HudTextEntry | null;
  subtitle: HudTextEntry | null;
}

export interface HitResultJson {
  type: "miss" | "block" | "entity";
  location: Vec3;
  pos?: BlockPos;
  face?: string;
  entity?: EntityJson;
}

export interface CursorState {
  /** The game holds the mouse (in-world look mode). */
  grabbed: boolean;
  screen: string | null;
  position: CursorPosition;
  /** The stack carried on the cursor in a container screen. */
  carried: ItemJson | null;
  hitResult: HitResultJson | null;
}

export interface ClientPlayerJson extends PlayerJson {
  food: number;
  saturation: number;
  exhaustion: number;
  gameMode: string | null;
  eyeHeight: number;
  vehicle: EntityJson | null;
}

export interface NearbyEntity extends EntityJson {
  distance: number;
}

export interface NearbyEntities {
  dimension: string;
  radius: number;
  /** Nearest first, at most `limit`. */
  entities: NearbyEntity[];
  /** How many were in range (may exceed the list). */
  count: number;
}

/** After an action that sent packets: a barrier came back from the server, so it handled them. */
export interface ServerRoundTrip {
  epoch: number;
  elapsedMs: number;
}

export interface CameraPoseJson {
  position: Vec3 | null;
  yaw: number | null;
  pitch: number | null;
  /** The keyframe's own field of view (camera.fly), when it has one. */
  fov?: number;
}

export interface CameraState {
  mode: "player" | "fixed" | "path";
  clean: boolean;
  fov: number;
  /** The game's main camera at the last frame. */
  camera: { position: Vec3; yaw: number; pitch: number; detached: boolean };
  path?: { poses: CameraPoseJson[]; durationMs: number; progress: number; now: CameraPoseJson };
}
