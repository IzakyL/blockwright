import { UiHost, resolveRole } from "@izakyl/blockwright-ui";
import type {
  AnyUiAdapter,
  RoleGuess,
  RoleRule,
  UiAction,
  UiAdapter,
  UiHostOptions,
  UiNode,
  UiSelector,
} from "@izakyl/blockwright-ui";
import type { MinecraftClient } from "../core/index.js";
import { CLIENT } from "../client/module.js";
import { clickSlot, clickWidget, selectWidget, waitForWidget } from "../client/screens.js";
import { GLFW_KEY_ENTER, key } from "../client/input.js";
import type { KeyModifiers, ScreenInfo, ScreenSlot, ScreenWidget, WidgetSelector } from "../client/types.js";
import { minecraftUiPlatform, optionsArg, uiWait, typeCode, type MinecraftUiProbe } from "./platform.js";

/** An adapter the Minecraft UI platform can run: its probes are {@link MinecraftUiProbe}s. */
export type MinecraftUiAdapter<State = unknown> = UiAdapter<MinecraftClient, MinecraftUiProbe, State>;

/** The vanilla adapter's id, which a library adapter names to supersede vanilla nodes. */
export const MINECRAFT_ADAPTER = "minecraft";

/** The vanilla adapter's key for the menu slot at `index` in menu.slots; a library that draws a
 *  menu slot itself names it this way to supersede the vanilla entry. */
export function menuSlotKey(index: number): string {
  return `slot:${index}`;
}

const MAX_WIDGETS = 100;

const GUESSES: RoleGuess = [
  [/EditBox|TextField/, "textbox"],
  [/Checkbox/, "checkbox"],
  [/Slider/, "slider"],
  [/Tab/, "tab"],
  [/Button/, "button"],
  [/List/, "list"],
  [/StringWidget|Text/, "text"],
  [/Image|Sprite/, "image"],
];

export interface MinecraftUiAdapterOptions {
  /** What vanilla-screen widgets are, where the class name does not say. */
  roles?: RoleRule[];
}

export interface VanillaUiState {
  screen: ScreenInfo;
  widgets: ScreenWidget[];
  slots: ScreenSlot[];
  /** Node key of each widget, by ScreenWidget.index. */
  keys: Map<number, string>;
}

/** What the read probe answers: the open screen, its widgets and its slots, in one client-thread turn. */
interface VanillaRead {
  screen: ScreenInfo;
  widgets: ScreenWidget[];
  slots: ScreenSlot[];
}

const READ_PROBE: MinecraftUiProbe = {
  imports: ["blockwright.minecraft.client.*", "blockwright.minecraft.core.client.*"],
  modules: [CLIENT],
  args: { limit: MAX_WIDGETS },
  body: `var mc = ClientGame.mc(ctx);
if (mc.screen == null) return null;
return Values.obj("screen", Screens.info(mc), "widgets", Screens.widgets(mc, (int) args.integer("limit", 1, 10_000, 100), false),
    "slots", Screens.slots(mc, false));`,
};

function widgetKeys(widgets: readonly ScreenWidget[]): Map<number, string> {
  const keys = new Map<number, string>();
  const ordinal = new Map<string, number>();
  for (const widget of widgets) {
    // selectWidget matches labels by substring, so a label is only a safe selector if no other label contains it.
    const label = widget.label;
    const unique = label !== undefined && label !== ""
      && widgets.filter((each) => (each.label ?? "").includes(label)).length === 1;
    const seen = ordinal.get(widget.className) ?? 0;
    ordinal.set(widget.className, seen + 1);
    keys.set(widget.index, unique ? `widget:${label}` : `widget:${widget.className}#${seen}`);
  }
  return keys;
}

function roleClass(widget: ScreenWidget): string {
  return /\$\d+$/.test(widget.className) && widget.superClassName ? widget.superClassName : widget.className;
}

function box(item: { x: number; y: number; width: number; height: number }) {
  return { x: item.x, y: item.y, width: item.width, height: item.height };
}

function isSlotSelector(selector: UiSelector): selector is UiSelector & { slot: number } {
  return typeof selector.slot === "number";
}

function clickOptions(action: Extract<UiAction, { kind: "click" }>): { button?: "right" | "middle"; modifiers?: KeyModifiers; double?: true } {
  return {
    ...(action.button && action.button !== "left" ? { button: action.button } : {}),
    ...(action.modifiers?.length ? { modifiers: [...action.modifiers] } : {}),
    ...(action.double ? { double: true as const } : {}),
  };
}

const FROM = "@izakyl/blockwright-minecraft";

/**
 * The adapter for vanilla screens: every widget of the open screen (by label, or class name and index when
 * the label is missing or repeats) and every slot of a container screen (by its index in menu.slots).
 * Clicks and typing go through the prefab's own in-game-waiting `screen.clickWidget` / `screen.clickSlot`; hovers and
 * scrolls through the platform's pointer.
 */
export function createMinecraftUiAdapter(options: MinecraftUiAdapterOptions = {}): MinecraftUiAdapter<VanillaUiState> {
  const widgetNode = (state: VanillaUiState, widget: ScreenWidget): UiNode => ({
    key: state.keys.get(widget.index)!,
    role: resolveRole(options.roles, GUESSES, { className: roleClass(widget) }),
    ...(widget.label ?? widget.tooltip ? { name: widget.label ?? widget.tooltip } : {}),
    ...(widget.value !== undefined ? { value: widget.value } : {}),
    className: widget.className,
    bounds: box(widget),
    ...(widget.visible ? { visibleBounds: box(widget) } : {}),
    states: { enabled: widget.enabled, visible: widget.visible, hittable: widget.visible },
    ...(widget.handle ? { handle: widget.handle } : {}),
    children: [],
  });

  const slotNode = (slot: ScreenSlot): UiNode => {
    const active = slot.active !== false;
    // AbstractContainerScreen hit-tests a slot one pixel beyond its 16x16 icon on every side.
    const hit = { x: slot.x - 1, y: slot.y - 1, width: 18, height: 18 };
    return {
      key: menuSlotKey(slot.index),
      role: "slot",
      ...(slot.item ? { name: slot.item.id, item: { id: slot.item.id, count: slot.item.count } } : {}),
      className: "net.minecraft.world.inventory.Slot",
      bounds: hit,
      ...(active ? { visibleBounds: hit } : {}),
      states: { enabled: active, visible: active, hittable: active },
      ...(slot.handle ? { handle: slot.handle } : {}),
      children: [],
    };
  };

  return {
    id: MINECRAFT_ADAPTER,
    summary: "vanilla screens: widgets by label (className, plus index when it repeats, for unlabelled ones), "
      + "container slots by menu index ({slot: n})",

    read: () => ({
      probes: { screen: READ_PROBE },
      parse(outcomes) {
        const outcome = outcomes.screen;
        if (!outcome) return undefined;
        if (outcome.error) throw new Error(`reading the open screen failed (${outcome.error.code}): ${outcome.error.message}`);
        const read = outcome.ok as VanillaRead | null;
        // No screen at all.
        if (!read) return undefined;
        const state: VanillaUiState = { ...read, keys: widgetKeys(read.widgets) };
        return {
          adapter: MINECRAFT_ADAPTER,
          roots: [...read.widgets.map((widget) => widgetNode(state, widget)), ...read.slots.map(slotNode)],
          state,
        };
      },
    }),

    locate(layer, node) {
      if (node.role === "slot" && node.key.startsWith("slot:")) {
        return { selector: { slot: Number(node.key.slice("slot:".length)) }, fragile: false };
      }
      const widget = layer.state.widgets.find((each) => layer.state.keys.get(each.index) === node.key)!;
      if (node.key === `widget:${widget.label}`) {
        return { selector: { label: widget.label }, fragile: false };
      }
      // selectWidget matches className by substring too.
      const sameClass = layer.state.widgets.filter((each) => each.className.includes(widget.className));
      return sameClass.length === 1
        ? { selector: { className: widget.className }, fragile: false }
        : { selector: { className: widget.className, index: widget.index }, fragile: true };
    },

    match(layer, selector) {
      if (isSlotSelector(selector)) {
        const slot = layer.state.slots.find((each) => each.index === selector.slot);
        return slot && slotNode(slot);
      }
      const widget = selectWidget(layer.state.widgets, selector as WidgetSelector);
      return widget && widgetNode(layer.state, widget);
    },

    async act(client, selector, action, { timeoutMs, signal }) {
      const wait = { ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(signal ? { signal } : {}) };
      if (isSlotSelector(selector)) {
        if (action.kind !== "click") return undefined;
        const done = await clickSlot(client, selector.slot, { ...clickOptions(action), ...wait });
        const what = done.slot.item ? ` (${done.slot.item.id})` : "";
        return {
          summary: `${describe(action)} slot ${selector.slot}${what}`,
          point: { x: done.slot.x + 8, y: done.slot.y + 8 },
        };
      }
      if (action.kind !== "click" && action.kind !== "type") return undefined;
      const done = await clickWidget(client, selector as WidgetSelector, action.kind === "click" ? { ...clickOptions(action), ...wait } : wait);
      const point = { x: done.widget.x + done.widget.width / 2, y: done.widget.y + done.widget.height / 2 };
      const name = JSON.stringify(done.widget.label ?? done.widget.id);
      if (action.kind === "click") {
        return { summary: `${describe(action)} ${name}`, point };
      }
      await key(client, { text: action.text });
      if (action.submit) await key(client, { keyCode: GLFW_KEY_ENTER });
      return { summary: `typed ${JSON.stringify(action.text)} into ${name}${action.submit ? " and pressed enter" : ""}`, point };
    },

    wait(client, selector, state, { timeoutMs, signal }) {
      if (isSlotSelector(selector)) {
        return uiWait(() => client.waitUntil({
          name: "ui.waitForSlot",
          clock: "frame",
          modules: [CLIENT],
          imports: ["blockwright.minecraft.client.*", "blockwright.minecraft.core.client.*"],
          args: { index: selector.slot, state },
          check: SLOT_CHECK,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(signal ? { signal } : {}),
        }));
      }
      return uiWait(() => waitForWidget(client, selector as WidgetSelector, {
        state,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      }));
    },

    codegen(selector, action) {
      if (isSlotSelector(selector)) {
        return action.kind === "click"
          ? { imports: [{ from: FROM, names: ["screen"] }], code: `await screen.clickSlot(client, ${selector.slot}${optionsArg(clickOptions(action))});` }
          : undefined;
      }
      const target = JSON.stringify(selector);
      if (action.kind === "click") {
        return { imports: [{ from: FROM, names: ["screen"] }], code: `await screen.clickWidget(client, ${target}${optionsArg(clickOptions(action))});` };
      }
      if (action.kind === "type") {
        return {
          imports: [{ from: FROM, names: ["screen", "input"] }],
          code: `await screen.clickWidget(client, ${target}); ${typeCode(action.text, action.submit)}`,
        };
      }
      return undefined;
    },
  };
}

/** `actionable`: the open container screen has the slot and it is active; `absent`: it has not, or it is inactive. */
const SLOT_CHECK = `var mc = ClientGame.mc(ctx);
int index = (int) args.integer("index");
boolean absent = "absent".equals(args.string("state"));
Map<String, Object> found = null;
for (Map<String, Object> slot : Screens.slots(mc, false)) {
    if (((Number) slot.get("index")).intValue() == index) {
        found = slot;
        break;
    }
}
boolean active = found != null && Boolean.TRUE.equals(found.get("active"));
if (active != absent) {
    return absent ? (Object) Boolean.TRUE : found;
}
return Wait.pending(Values.obj("screen", ClientGame.screenClass(mc), "slot", found == null ? "missing" : active ? "active" : "inactive"));`;

function describe(action: Extract<UiAction, { kind: "click" }>): string {
  const button = action.button ?? "left";
  const modifiers = action.modifiers?.length ? `${action.modifiers.join("+")}+` : "";
  return `${modifiers}${button === "left" ? "" : `${button} `}${action.double ? "double-clicked" : "clicked"}`;
}

/** The vanilla adapter with default roles. */
export const minecraftUiAdapter: MinecraftUiAdapter<VanillaUiState> = createMinecraftUiAdapter();

/**
 * A UI host on the Minecraft platform: the vanilla adapter first (it draws beneath everything), then the
 * given library adapters in drawing order.
 */
export function minecraftUiHost(
  adapters: readonly AnyUiAdapter<MinecraftClient, MinecraftUiProbe>[] = [],
  options: UiHostOptions & { vanilla?: MinecraftUiAdapter<VanillaUiState> } = {},
): UiHost<MinecraftClient, MinecraftUiProbe> {
  const { vanilla = minecraftUiAdapter, ...hostOptions } = options;
  return new UiHost(minecraftUiPlatform, [vanilla, ...adapters], hostOptions);
}
