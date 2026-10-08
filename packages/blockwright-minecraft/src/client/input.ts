import type { CallOptions, MinecraftClient, ReflectQuerySpec, ReflectRoot } from "../core/index.js";
import { deadlineAbove, defined } from "../core/templates.js";
import { clientTask } from "./module.js";
import type {
  ClickResult,
  CursorPosition,
  KeyModifiers,
  MouseButtonName,
  MouseButtonResult,
  MouseDispatch,
  ScreenClickResult,
} from "./types.js";

/** A GUI-scaled point on the window. */
export interface Point {
  x: number;
  y: number;
}

export type KeyAction = "tap" | "press" | "release";

/** The GLFW key code of Enter, for `input.key(client, { keyCode })`. */
export const GLFW_KEY_ENTER = 257;

/**
 * One key input: a keybind by name (`key.inventory` or the Options field `keyInventory`; whatever key or
 * button it is bound to), a raw GLFW key code (what a screen's text field or shortcut reads), or text typed
 * into whatever has focus on the open screen. `action` is `tap` by default: a press and a release; a tap
 * of a keybind (or of a raw key while no screen is open) answers after the next client tick, so the game
 * has acted on it. `modifiers` read as held (Screen.hasShiftDown and friends) while each event is dispatched.
 */
export type KeyInput =
  | { keybind: string; action?: KeyAction; modifiers?: KeyModifiers }
  | { keyCode: number; scanCode?: number; action?: KeyAction | "repeat"; modifiers?: KeyModifiers }
  | { text: string };

/** What a keybind press or release did (a tap answers the release, with the press under `press`). */
export interface KeybindResult {
  keybind: string;
  /** The key mapping's name, e.g. `key.inventory`. */
  mapping: string;
  pressed: boolean;
  /** `keysym`, `scancode` or `mouse`: what the keybind is bound to. */
  keyType: string;
  key: string;
  /** The open screen when it went in. */
  screen: string | null;
  screenOpen: boolean;
  /** When bound to a mouse button: what the button event went through. */
  dispatch?: MouseDispatch;
  tap?: true;
  press?: KeybindResult;
}

/** What a raw key event did (a tap answers the release, with the press under `press`). */
export interface RawKeyResult {
  keyCode: number;
  scanCode: number;
  action: "press" | "release" | "repeat";
  modifiers: number;
  screen: string | null;
  screenAfter: string | null;
  tap?: true;
  press?: RawKeyResult;
}

export interface TypedTextResult {
  text: string;
  /** Code points sent. */
  codepoints: number;
  screen: string;
}

export type KeyResult = KeybindResult | RawKeyResult | TypedTextResult;

const KEY = clientTask<KeyInput, KeyResult>("input.key", "return Keys.key(ctx, Args.of(ctx));");

/** One key input: a keybind, a raw key event or typed text; see {@link KeyInput}. */
export function key(client: MinecraftClient, input: Extract<KeyInput, { keybind: string }>, options?: CallOptions): Promise<KeybindResult>;
export function key(client: MinecraftClient, input: Extract<KeyInput, { keyCode: number }>, options?: CallOptions): Promise<RawKeyResult>;
export function key(client: MinecraftClient, input: Extract<KeyInput, { text: string }>, options?: CallOptions): Promise<TypedTextResult>;
export function key(client: MinecraftClient, input: KeyInput, options?: CallOptions): Promise<KeyResult>;
export function key(client: MinecraftClient, input: KeyInput, options: CallOptions = {}): Promise<KeyResult> {
  return client.run(KEY, input, options);
}

export interface MoveCursorResult {
  cursor: CursorPosition;
  /** A button was held on a screen, so the move was a drag step. */
  dragged: boolean;
  screen: string | null;
}

const MOVE = clientTask<Point, MoveCursorResult>("input.move",
  `Args args = Args.of(ctx);
return Mouse.move(ClientGame.mc(ctx), args.number("x"), args.number("y"));`);

/** Puts the cursor at a GUI-scaled point; with a button held on a screen, that is a drag step. */
export function moveCursor(client: MinecraftClient, to: Point, options: CallOptions = {}): Promise<MoveCursorResult> {
  return client.run(MOVE, { x: to.x, y: to.y }, options);
}

export interface MouseButtonOptions {
  button?: MouseButtonName;
  action: "press" | "release";
  modifiers?: KeyModifiers;
  /**
   * Only press when the object `root` resolves to (usually a static path to what the UI reports hovered)
   * is one of the `within` handles; otherwise nothing is sent and the call throws `hover-mismatch`
   * (detail `{hovered: {class, handle} | null}`). With `timeoutMs`, a mismatch is re-checked in the game after
   * every rendered frame and the press goes out once it matches; `hover-mismatch` only after that long.
   */
  hovered?: { root: ReflectRoot; within: string[]; timeoutMs?: number };
  /** A reflect query read right after dispatch, in the same client-thread turn (answered as `observed`). */
  observe?: ReflectQuerySpec;
}

const MOUSE_BUTTON = clientTask<MouseButtonOptions, MouseButtonResult>("input.button",
  "return Mouse.buttonTask(ctx, Args.of(ctx));");

/** One button event through MouseHandler.onPress, at the cursor's current position. */
export function mouseButton(client: MinecraftClient, press: MouseButtonOptions, options: CallOptions = {}): Promise<MouseButtonResult> {
  const waitMs = press.hovered?.timeoutMs ?? 0;
  return client.run(MOUSE_BUTTON, press, { ...(waitMs > 0 ? { timeoutMs: deadlineAbove(waitMs) } : {}), ...options });
}

export interface ClickOptions extends CallOptions {
  button?: MouseButtonName;
  modifiers?: KeyModifiers;
  /** Two clicks in quick succession (mouse route). */
  double?: boolean;
}

export interface ScreenRouteOptions extends CallOptions {
  /** Click on the open screen itself (Screen.mouseClicked/mouseReleased) instead of through the mouse. */
  route: "screen";
  button?: MouseButtonName;
  /** When the screen does not take the click and this handle is a visible, active button, it is pressed directly. */
  handle?: string;
}

const CLICK = clientTask<Point & Omit<ClickOptions, keyof CallOptions>, ClickResult>("input.click",
  "return Mouse.click(ctx, Args.of(ctx));");

const CLICK_SCREEN = clientTask<Point & { button?: MouseButtonName; handle?: string }, ScreenClickResult>(
  "input.clickScreen", "return Screens.clickScreenTask(ctx, Args.of(ctx));");

/**
 * A click at a GUI-scaled point. Through the mouse (default): cursor move, press, release, in one
 * client-thread turn; with no screen open the click acts through the keybinds (attack/use), and the answer
 * comes after the client tick that did. With `route: "screen"`, on the open screen itself.
 */
export function click(client: MinecraftClient, at: Point, options?: ClickOptions): Promise<ClickResult>;
export function click(client: MinecraftClient, at: Point, options: ScreenRouteOptions): Promise<ScreenClickResult>;
export function click(client: MinecraftClient, at: Point, options: ClickOptions | ScreenRouteOptions = {}): Promise<ClickResult | ScreenClickResult> {
  const { signal, timeoutMs, ...rest } = options;
  const call = defined({ signal, timeoutMs });
  if ("route" in rest && rest.route === "screen") {
    const { route: _route, ...screen } = rest;
    return client.run(CLICK_SCREEN, { x: at.x, y: at.y, ...defined(screen) }, call);
  }
  return client.run(CLICK, { x: at.x, y: at.y, ...defined(rest as Omit<ClickOptions, keyof CallOptions>) }, call);
}

export interface ScrollOptions {
  /** Move the cursor here first (GUI-scaled); default where it is. */
  at?: Point;
  /** Default 0. */
  xOffset?: number;
  /** Lines; positive scrolls up. Default 0. */
  yOffset?: number;
  /** Wheel events of that offset each, sent in one client-thread turn (1..100); default 1. */
  count?: number;
  modifiers?: KeyModifiers;
}

export interface ScrollResult {
  xOffset: number;
  yOffset: number;
  count: number;
  cursor: CursorPosition;
  screen: string | null;
}

const SCROLL = clientTask<Omit<ScrollOptions, "at"> & Partial<Point>, ScrollResult>("input.scroll", "return Mouse.scroll(ctx, Args.of(ctx));");

/** Scrolls through MouseHandler.onScroll (at the cursor, or at `at` after moving there), `count` events in one turn. */
export function scroll(client: MinecraftClient, wheel: ScrollOptions, options: CallOptions = {}): Promise<ScrollResult> {
  const { at, ...rest } = wheel;
  return client.run(SCROLL, { ...rest, ...(at ? { x: at.x, y: at.y } : {}) }, options);
}

export interface DragOptions {
  from: Point;
  to: Point;
  /** Moves between press and release; default 8. */
  steps?: number;
  button?: MouseButtonName;
  modifiers?: KeyModifiers;
}

export interface DragResult {
  from: CursorPosition;
  to: CursorPosition;
  steps: number;
  /** Moves that reached the screen. */
  dispatched: number;
  /** The press armed a drag (MouseHandler's active button and press time were set). */
  pressArmed: boolean;
  windowActive: boolean;
  press: { vanillaStateUpdated: boolean; screenHandled: boolean };
  release: { vanillaStateUpdated: boolean; screenHandled: boolean };
}

const DRAG = clientTask<DragOptions, DragResult>("input.drag", "return Mouse.drag(ctx, Args.of(ctx));");

/** A drag on the open screen: press at `from`, `steps` moves, release at `to`, in one client-thread turn. */
export function drag(client: MinecraftClient, gesture: DragOptions, options: CallOptions = {}): Promise<DragResult> {
  return client.run(DRAG, gesture, options);
}
