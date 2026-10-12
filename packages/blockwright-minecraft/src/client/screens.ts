import { globMatches } from "@izakyl/blockwright-client";
import type { CallOptions, MinecraftClient } from "../core/index.js";
import { isMinecraftError } from "../core/errors.js";
import { defined, waitBudget } from "../core/templates.js";
import { clientTask } from "./module.js";
import type {
  ClickResult,
  DismissResult,
  KeyModifiers,
  MouseButtonName,
  ScreenClickResult,
  ScreenInfo,
  ScreenSlot,
  ScreenWidget,
  WidgetSelector,
  WidgetState,
} from "./types.js";

const SCREEN = clientTask<void, ScreenInfo | null>("state.screen", "return Values.obj(\"screen\", Screens.info(ClientGame.mc(ctx)));",
  { parse: (value) => ((value as { screen: ScreenInfo | null }).screen ?? null) });

/** The open screen, or null. */
export function stateScreen(client: MinecraftClient, options: CallOptions = {}): Promise<ScreenInfo | null> {
  return client.run(SCREEN, undefined, options);
}

const WIDGETS = clientTask<{ limit?: number; handles?: boolean }, { screen: ScreenInfo | null; widgets: ScreenWidget[] }>(
  "screen.widgets", "return Screens.widgetsTask(ctx, Args.of(ctx));");

/** The open screen's widgets (its direct children), each with a handle unless `handles: false`; [] with no screen. */
export async function screenWidgets(
  client: MinecraftClient,
  options: { limit?: number; handles?: boolean } & CallOptions = {},
): Promise<ScreenWidget[]> {
  const { signal, timeoutMs, ...args } = options;
  return (await client.run(WIDGETS, args, defined({ signal, timeoutMs }))).widgets;
}

const SLOTS = clientTask<{ handles?: boolean }, { screen: ScreenInfo | null; slots: ScreenSlot[] }>(
  "screen.slots", "return Screens.slotsTask(ctx, Args.of(ctx));");

/** The open container screen's slots in menu order, at screen coordinates; [] for any other screen. */
export async function containerSlots(client: MinecraftClient, options: { handles?: boolean } & CallOptions = {}): Promise<ScreenSlot[]> {
  const { signal, timeoutMs, ...args } = options;
  return (await client.run(SLOTS, args, defined({ signal, timeoutMs }))).slots;
}

/** A wait's options: `timeoutMs` is its in-game budget (default 10000). */
export type ScreenWaitOptions = CallOptions;

const WAIT_SCREEN = clientTask<{ className: string; wait: { timeoutMs: number } }, ScreenInfo>("waitForScreen",
  "return Screens.waitForScreen(ctx, Args.of(ctx)).thenApply(result -> result.value());");

/**
 * Waits in the game (checked every frame) until a screen whose class, or a superclass, has a name containing
 * `className` is open; answers it. Throws MinecraftTimeoutError (`last: {screen}`) otherwise.
 */
export function waitForScreen(client: MinecraftClient, className: string, options: ScreenWaitOptions = {}): Promise<ScreenInfo> {
  const { wait, run } = waitBudget(options.timeoutMs, options.signal);
  return client.run(WAIT_SCREEN, { className, wait }, run);
}

/**
 * {@link waitForScreen} that answers `null` when no such screen opened in time instead of throwing; without a
 * `className` it waits for any screen.
 */
export async function tryWaitForScreen(client: MinecraftClient, className = "", options: ScreenWaitOptions = {}): Promise<ScreenInfo | null> {
  try {
    return await waitForScreen(client, className, options);
  } catch (error) {
    if (isMinecraftError(error, "wait-timeout")) return null;
    throw error;
  }
}

export interface WidgetWaitOptions extends ScreenWaitOptions {
  /** Default `actionable` (visible and enabled). */
  state?: WidgetState;
}

const WAIT_WIDGET = clientTask<
  { selector: WidgetSelector; state: WidgetState; wait: { timeoutMs: number } },
  { widget: ScreenWidget | null }
>("waitForWidget", "return Screens.waitForWidget(ctx, Args.of(ctx));");

/**
 * Waits in the game (every frame) until the widget `selector` picks is in `state`; answers it (undefined
 * when waiting for `absent`). Throws MinecraftTimeoutError (`last: {screen, widgets, match}`) otherwise.
 */
export async function waitForWidget(
  client: MinecraftClient,
  selector: WidgetSelector,
  options: WidgetWaitOptions = {},
): Promise<ScreenWidget | undefined> {
  const { wait, run } = waitBudget(options.timeoutMs, options.signal);
  const result = await client.run(WAIT_WIDGET, { selector, state: options.state ?? "actionable", wait }, run);
  return result.widget ?? undefined;
}

export interface ScreenClickOptions {
  button?: MouseButtonName;
  modifiers?: KeyModifiers;
}

export interface ClickWidgetOptions extends ScreenClickOptions, ScreenWaitOptions {
  /** `mouse` (default): through the mouse at the widget's centre; `screen`: Screen.mouseClicked directly. */
  route?: "mouse" | "screen";
  double?: boolean;
}

export interface ClickWidgetResult {
  /** The widget as it was when clicked. */
  widget: ScreenWidget;
  click: ClickResult | ScreenClickResult;
}

const CLICK_WIDGET = clientTask<
  { selector: WidgetSelector; wait: { timeoutMs: number } } & Omit<ClickWidgetOptions, "timeoutMs" | "signal">,
  ClickWidgetResult
>("clickWidget", "return Screens.clickWidget(ctx, Args.of(ctx));");

/** Waits in the game until the selected widget is actionable, then clicks its centre — one run. */
export function clickWidget(
  client: MinecraftClient,
  selector: WidgetSelector,
  options: ClickWidgetOptions = {},
): Promise<ClickWidgetResult> {
  const { timeoutMs, signal, ...click } = options;
  const { wait, run } = waitBudget(timeoutMs, signal);
  return client.run(CLICK_WIDGET, { selector, wait, ...click }, run);
}

export interface ClickSlotResult {
  /** The slot as it was before the click. */
  slot: ScreenSlot;
  click: ClickResult;
}

const CLICK_SLOT = clientTask<
  { index: number; wait: { timeoutMs: number }; button?: MouseButtonName; modifiers?: KeyModifiers; double?: boolean },
  ClickSlotResult
>("clickSlot", "return Screens.clickSlot(ctx, Args.of(ctx));");

/** Minecraft reads two presses of one button on one slot within 250 ms as a double click. */
const DOUBLE_CLICK_MS = 300;
const LAST_SLOT_CLICK = new WeakMap<MinecraftClient, { index: number; button: string; at: number }>();

/**
 * Clicks the container slot `index` (its position in menu.slots) at its centre through the mouse, once the
 * open screen has it and it is active (waited for in the game). Two separate calls on one slot stay two
 * clicks (the second is held back past the game's double-click window); ask for `double` by name.
 */
export async function clickSlot(
  client: MinecraftClient,
  index: number,
  options: ScreenClickOptions & ScreenWaitOptions & { double?: boolean } = {},
): Promise<ClickSlotResult> {
  const { timeoutMs, signal, ...click } = options;
  const button = click.button ?? "left";
  const last = LAST_SLOT_CLICK.get(client);
  if (!click.double && last?.index === index && last.button === button) {
    const wait = last.at + DOUBLE_CLICK_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  const { wait, run } = waitBudget(timeoutMs, signal);
  const result = await client.run(CLICK_SLOT, { index, wait, ...click, button }, run);
  LAST_SLOT_CLICK.set(client, { index, button, at: Date.now() });
  return result;
}

const DISMISS = clientTask<{ wait: { timeoutMs: number } }, DismissResult>("screen.dismiss",
  "return Screens.dismiss(ctx, Args.of(ctx));");

/**
 * Closes every open screen with ESC, the way a player would: one ESC per screen, again only if that screen
 * is still open 10 frames later, until none is open. A screen that will not close throws a
 * MinecraftTimeoutError (`wait-timeout`, `last: {screen, closesOnEsc, escapes}`).
 */
export function dismissScreen(client: MinecraftClient, options: ScreenWaitOptions = {}): Promise<DismissResult> {
  const { wait, run } = waitBudget(options.timeoutMs, options.signal);
  return client.run(DISMISS, { wait }, run);
}

// ---- pure helpers (the same rules Screens.java applies in the game) ----

/** The widget `selector` picks from `widgets`; see {@link WidgetSelector}. */
export function selectWidget(widgets: readonly ScreenWidget[], selector: WidgetSelector | undefined): ScreenWidget | undefined {
  if (!selector) return widgets[0];
  const candidates = selector.index === undefined ? widgets : widgets.filter((w) => w.index === selector.index);
  if (selector.id !== undefined) return candidates.find((w) => w.id.includes(selector.id!));
  if (selector.label !== undefined) return candidates.find((w) => (w.label ?? "").includes(selector.label!));
  if (selector.tooltip !== undefined) return candidates.find((w) => (w.tooltip ?? "").includes(selector.tooltip!));
  if (selector.className !== undefined) return candidates.find((w) => w.className.includes(selector.className!));
  if (selector.idPattern !== undefined) return candidates.find((w) => globMatches(selector.idPattern!, w.id));
  if (selector.labelPattern !== undefined) return candidates.find((w) => globMatches(selector.labelPattern!, w.label ?? ""));
  return candidates[0];
}

export function isActionable(widget: ScreenWidget | undefined): widget is ScreenWidget {
  return widget !== undefined && widget.visible && widget.enabled;
}

/** Whether a widget (undefined when nothing matched) is in `state`. */
export function widgetInState(widget: ScreenWidget | undefined, state: WidgetState): boolean {
  switch (state) {
    case "absent":
      return widget === undefined || !widget.visible;
    case "present":
      return widget !== undefined;
    case "actionable":
      return isActionable(widget);
  }
}
