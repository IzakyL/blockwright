package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.GameJson;
import blockwright.minecraft.core.Handles;
import blockwright.minecraft.core.Wait;
import blockwright.minecraft.core.client.ClientGame;
import dev.blockwright.api.Context;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.navigation.ScreenRectangle;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;
import org.lwjgl.glfw.GLFW;

/**
 * Vanilla screens: what is open, its widgets ({@code screen.children()}) and container slots, selecting a
 * widget, waiting in the game for a screen or widget, clicking them, and dismissing screens. Coordinates are
 * GUI-scaled. Client thread.
 *
 * <p>A widget is {@code {id, label?, tooltip?, value?, className, superClassName?, index, x, y, width, height,
 * enabled, visible, focused, handle?}} ({@code id} is the label, else the tooltip, else
 * {@code className#index}). A slot is {@code {index, x, y, width: 16, height: 16, item?, active, handle?}}
 * with screen coordinates of its icon's top-left corner.
 *
 * <p>A selector is {@code {id?, idPattern?, label?, labelPattern?, tooltip?, className?, index?}}: {@code index}
 * narrows first, then the first given of id, label, tooltip, className (substring matches) or idPattern,
 * labelPattern (anchored globs, {@code *} the only wildcard) picks the first widget that matches; an empty
 * selector picks the first widget.
 */
public final class Screens {
    public static final long ESC_RESEND_FRAMES = 10;

    private Screens() {
    }

    // ---- the open screen ----

    /** {@code {className, superClassName, title, width, height, closesOnEsc, pauses, container, menu?}} or null. */
    public static Map<String, Object> info(Minecraft mc) {
        Screen screen = mc.screen;
        if (screen == null) {
            return null;
        }
        Map<String, Object> info = obj(
            "className", screen.getClass().getName(),
            "superClassName", screen.getClass().getSuperclass().getName(),
            "title", screen.getTitle().getString(),
            "width", screen.width,
            "height", screen.height,
            "closesOnEsc", screen.shouldCloseOnEsc(),
            "pauses", screen.isPauseScreen(),
            "container", screen instanceof AbstractContainerScreen<?>);
        if (screen instanceof AbstractContainerScreen<?> container) {
            info.put("menu", container.getMenu().getClass().getName());
            info.put("left", container.getGuiLeft());
            info.put("top", container.getGuiTop());
        }
        return info;
    }

    /** Whether {@code screen}'s class, or one of its superclasses, has a name containing {@code name}. */
    public static boolean isA(Object screen, String name) {
        for (Class<?> type = screen == null ? null : screen.getClass(); type != null && type != Object.class;
             type = type.getSuperclass()) {
            if (type.getName().contains(name)) {
                return true;
            }
        }
        return false;
    }

    // ---- widgets ----

    /** The open screen's widgets (its direct children), at most {@code limit}; empty with no screen. */
    public static List<Map<String, Object>> widgets(Minecraft mc, int limit, boolean handles) {
        List<Map<String, Object>> widgets = new ArrayList<>();
        Screen screen = mc.screen;
        if (screen == null) {
            return widgets;
        }
        int index = 0;
        for (GuiEventListener child : screen.children()) {
            if (widgets.size() >= limit) {
                break;
            }
            widgets.add(widget(child, index++, handles));
        }
        return widgets;
    }

    public static Map<String, Object> widget(GuiEventListener child, int index, boolean handles) {
        String className = child.getClass().getName();
        String label = null;
        String tooltip = null;
        boolean enabled = true;
        boolean visible = true;
        int x;
        int y;
        int width;
        int height;
        if (child instanceof AbstractWidget widget) {
            label = text(widget.getMessage());
            Tooltip held = widget.getTooltip();
            tooltip = held == null ? null : tooltipText(held);
            enabled = widget.active;
            visible = widget.visible;
            x = widget.getX();
            y = widget.getY();
            width = widget.getWidth();
            height = widget.getHeight();
        } else {
            ScreenRectangle rectangle = child.getRectangle();
            x = rectangle.left();
            y = rectangle.top();
            width = rectangle.width();
            height = rectangle.height();
        }
        Map<String, Object> json = obj(
            "id", label != null ? label : tooltip != null ? tooltip : className + "#" + index,
            "label", label,
            "tooltip", tooltip,
            "value", value(child),
            "className", className,
            "superClassName", child.getClass().getSuperclass().getName(),
            "index", index,
            "x", x,
            "y", y,
            "width", width,
            "height", height,
            "enabled", enabled,
            "visible", visible,
            "focused", child.isFocused());
        if (handles) {
            json.put("handle", Handles.registerShared(child));
        }
        json.values().removeIf(v -> v == null);
        return json;
    }

    private static String text(Component component) {
        if (component == null) {
            return null;
        }
        String text = component.getString();
        return text.isEmpty() ? null : text;
    }

    private static String tooltipText(Tooltip tooltip) {
        try {
            Field message = Tooltip.class.getDeclaredField("message");
            message.setAccessible(true);
            return text((Component) message.get(tooltip));
        } catch (ReflectiveOperationException | RuntimeException unreadable) {
            return null;
        }
    }

    /** What a widget holds: an edit box's text, else a public {@code getValue()} when it has one. */
    private static Object value(GuiEventListener child) {
        if (child instanceof EditBox box) {
            return box.getValue();
        }
        try {
            Method getter = child.getClass().getMethod("getValue");
            Object value = getter.invoke(child);
            return value instanceof String || value instanceof Number || value instanceof Boolean ? String.valueOf(value)
                : value instanceof Component component ? component.getString() : null;
        } catch (ReflectiveOperationException | RuntimeException none) {
            return null;
        }
    }

    // ---- selectors ----

    /** The widget {@code selector} picks, or null. */
    public static Map<String, Object> select(List<Map<String, Object>> widgets, Args selector) {
        List<Map<String, Object>> candidates = widgets;
        if (selector != null && selector.has("index")) {
            long index = selector.integer("index");
            candidates = widgets.stream().filter(w -> ((Number) w.get("index")).longValue() == index).toList();
        }
        if (selector == null) {
            return candidates.isEmpty() ? null : candidates.get(0);
        }
        String[][] substrings = {{"id", "id"}, {"label", "label"}, {"tooltip", "tooltip"}, {"className", "className"}};
        for (String[] field : substrings) {
            if (selector.has(field[0])) {
                String wanted = selector.string(field[0]);
                return candidates.stream().filter(w -> String.valueOf(w.getOrDefault(field[1], "")).contains(wanted))
                    .findFirst().orElse(null);
            }
        }
        String[][] globs = {{"idPattern", "id"}, {"labelPattern", "label"}};
        for (String[] field : globs) {
            if (selector.has(field[0])) {
                Pattern pattern = glob(selector.string(field[0]));
                return candidates.stream().filter(w -> pattern.matcher(String.valueOf(w.getOrDefault(field[1], ""))).matches())
                    .findFirst().orElse(null);
            }
        }
        return candidates.isEmpty() ? null : candidates.get(0);
    }

    /** An anchored glob where {@code *} is the only wildcard. */
    public static Pattern glob(String pattern) {
        List<String> parts = new ArrayList<>();
        for (String part : pattern.split("\\*", -1)) {
            parts.add(Pattern.quote(part));
        }
        return Pattern.compile(String.join(".*", parts), Pattern.DOTALL);
    }

    public static boolean actionable(Map<String, Object> widget) {
        return widget != null && Boolean.TRUE.equals(widget.get("visible")) && Boolean.TRUE.equals(widget.get("enabled"));
    }

    /** Whether {@code widget} (null: nothing matched) is in {@code state}: {@code actionable} or {@code absent}. */
    public static boolean inState(Map<String, Object> widget, String state) {
        return switch (state) {
            case "absent" -> widget == null || !Boolean.TRUE.equals(widget.get("visible"));
            case "present" -> widget != null;
            case "actionable" -> actionable(widget);
            default -> throw Fail.invalid("widget state must be actionable, present or absent; got " + state);
        };
    }

    // ---- slots ----

    /** The open container screen's slots ({@code menu.slots}); empty for any other screen. */
    public static List<Map<String, Object>> slots(Minecraft mc, boolean handles) {
        List<Map<String, Object>> slots = new ArrayList<>();
        if (!(mc.screen instanceof AbstractContainerScreen<?> screen)) {
            return slots;
        }
        int left = screen.getGuiLeft();
        int top = screen.getGuiTop();
        for (Slot slot : screen.getMenu().slots) {
            Map<String, Object> json = obj("index", slot.index, "x", left + slot.x, "y", top + slot.y,
                "width", 16, "height", 16);
            ItemStack stack = slot.getItem();
            if (!stack.isEmpty()) {
                json.put("item", GameJson.item(stack));
            }
            json.put("active", slot.isActive());
            if (handles) {
                json.put("handle", Handles.registerShared(slot));
            }
            slots.add(json);
        }
        return slots;
    }

    private static Map<String, Object> slot(Minecraft mc, int index) {
        for (Map<String, Object> slot : slots(mc, false)) {
            if (((Number) slot.get("index")).intValue() == index) {
                return slot;
            }
        }
        return null;
    }

    // ---- task entry points ----

    /** {@code {screen, widgets}}: the open screen and its widgets in one read. */
    public static Map<String, Object> widgetsTask(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        return obj("screen", info(mc),
            "widgets", widgets(mc, (int) args.integer("limit", 1, 10_000, 200), args.flag("handles", true)));
    }

    public static Map<String, Object> slotsTask(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        return obj("screen", info(mc), "slots", slots(mc, args.flag("handles", true)));
    }

    /** Waits (every frame) until a screen whose class name contains {@code className} is open; answers its info. */
    public static CompletableFuture<Wait.Result> waitForScreen(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        String className = args.string("className");
        return Wait.until(ctx, Wait.Clock.FRAME, Wait.Options.of(args.object("wait")), () -> {
            Screen screen = mc.screen;
            if (screen != null && isA(screen, className)) {
                return info(mc);
            }
            return Wait.pending(obj("screen", screen == null ? null : screen.getClass().getName()));
        });
    }

    /**
     * Waits (every frame) until the widget {@code selector} picks is in {@code state} ({@code actionable} by
     * default, or {@code present} / {@code absent}); answers {@code {widget}} ({@code widget} null for absent).
     */
    public static CompletableFuture<Object> waitForWidget(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Args selector = args.object("selector");
        String state = args.string("state", "actionable");
        boolean handles = args.flag("handles", true);
        return Wait.until(ctx, Wait.Clock.FRAME, Wait.Options.of(args.object("wait")), () -> {
            List<Map<String, Object>> widgets = widgets(mc, 1000, false);
            Map<String, Object> match = select(widgets, selector);
            if (inState(match, state)) {
                return obj("found", true);
            }
            return Wait.pending(obj("screen", ClientGame.screenClass(mc), "widgets", widgets.size(),
                "match", match == null ? null : obj("id", match.get("id"), "visible", match.get("visible"),
                    "enabled", match.get("enabled"))));
        }).thenApply(result -> {
            Map<String, Object> match = select(widgets(mc, 1000, handles), selector);
            return obj("widget", "absent".equals(state) ? null : match, "screen", info(mc), "ticks", result.ticks(),
                "elapsedMs", result.elapsedMs());
        });
    }

    /**
     * Waits until the selected widget is actionable, then clicks its centre: through the mouse
     * ({@code route: "mouse"}, default: cursor move, press, release) or on the screen itself
     * ({@code route: "screen"}, see {@link Mouse#clickScreen}). Answers {@code {widget, click}}.
     */
    public static CompletableFuture<Object> clickWidget(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Args selector = args.object("selector");
        String route = args.string("route", "mouse");
        int button = Mouse.buttonCode(args.string("button", "left"));
        int modifiers = Keys.modifiers(args);
        int count = args.flag("double", false) ? 2 : 1;
        if (!route.equals("mouse") && !route.equals("screen")) {
            throw Fail.invalid("route must be mouse or screen; got " + route);
        }
        return Wait.until(ctx, Wait.Clock.FRAME, Wait.Options.of(args.object("wait")), () -> {
            List<Map<String, Object>> widgets = widgets(mc, 1000, false);
            Map<String, Object> match = select(widgets, selector);
            if (actionable(match)) {
                return true;
            }
            return Wait.pending(obj("screen", ClientGame.screenClass(mc), "widgets", widgets.size(),
                "match", match == null ? null : obj("id", match.get("id"), "visible", match.get("visible"),
                    "enabled", match.get("enabled"))));
        }).thenCompose(found -> ctx.onClient(() -> {
            Map<String, Object> widget = select(widgets(mc, 1000, true), selector);
            if (!actionable(widget)) {
                throw Fail.notFound("the widget stopped being actionable before the click");
            }
            double x = ((Number) widget.get("x")).doubleValue() + ((Number) widget.get("width")).doubleValue() / 2;
            double y = ((Number) widget.get("y")).doubleValue() + ((Number) widget.get("height")).doubleValue() / 2;
            Map<String, Object> click = route.equals("screen")
                ? Mouse.clickScreen(mc, x, y, button, (String) widget.get("handle"))
                : Mouse.clickAt(mc, x, y, button, modifiers, count);
            return (Object) obj("widget", widget, "click", click);
        }));
    }

    /**
     * Waits until the open container screen has slot {@code index} (menu order) and it is active, then clicks
     * its centre through the mouse. Answers {@code {slot, click}} with the slot as it was before the click.
     */
    public static CompletableFuture<Object> clickSlot(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        int index = (int) args.integer("index", 0, Integer.MAX_VALUE, 0);
        int button = Mouse.buttonCode(args.string("button", "left"));
        int modifiers = Keys.modifiers(args);
        int count = args.flag("double", false) ? 2 : 1;
        return Wait.until(ctx, Wait.Clock.FRAME, Wait.Options.of(args.object("wait")), () -> {
            Map<String, Object> slot = slot(mc, index);
            if (slot != null && Boolean.TRUE.equals(slot.get("active"))) {
                return true;
            }
            return Wait.pending(obj("screen", ClientGame.screenClass(mc),
                "slot", slot == null ? "missing" : "inactive"));
        }).thenCompose(found -> ctx.onClient(() -> {
            Map<String, Object> slot = slot(mc, index);
            if (slot == null) {
                throw Fail.notFound("the open screen has no slot " + index);
            }
            double x = ((Number) slot.get("x")).doubleValue() + 8;
            double y = ((Number) slot.get("y")).doubleValue() + 8;
            return (Object) obj("slot", slot, "click", Mouse.clickAt(mc, x, y, button, modifiers, count));
        }));
    }

    /** {@code clickScreen} as a task: {@code {x, y, button?, handle?}}. */
    public static Map<String, Object> clickScreenTask(Context ctx, Args args) {
        return Mouse.clickScreen(ClientGame.mc(ctx), args.number("x"), args.number("y"),
            Mouse.buttonCode(args.string("button", "left")), args.string("handle", null));
    }

    /**
     * Closes every open screen the way a player would, with ESC — once per screen (a screen that takes a few
     * frames to close must not get a second ESC, which would close its parent or open the pause menu), again
     * only if the same screen is still open {@link #ESC_RESEND_FRAMES} frames later. Answers
     * {@code {closed: true, dismissed, initialScreen, escapes, elapsedMs}}; a screen that will not close
     * ({@code shouldCloseOnEsc() == false}, or ESC does nothing) ends it {@code wait-timeout}.
     */
    public static CompletableFuture<Object> dismiss(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        String initial = ClientGame.screenClass(mc);
        Object[] pressedScreen = {null};
        long[] frame = {0, 0};
        int[] escapes = {0};
        return Wait.until(ctx, Wait.Clock.FRAME, Wait.Options.of(args.object("wait")), () -> {
            frame[0]++;
            Screen screen = mc.screen;
            if (screen == null) {
                return true;
            }
            boolean closesOnEsc = screen.shouldCloseOnEsc();
            boolean due = screen != pressedScreen[0] || frame[0] - frame[1] >= ESC_RESEND_FRAMES;
            if (closesOnEsc && due) {
                long window = mc.getWindow().getWindow();
                mc.keyboardHandler.keyPress(window, GLFW.GLFW_KEY_ESCAPE, 0, GLFW.GLFW_PRESS, 0);
                mc.keyboardHandler.keyPress(window, GLFW.GLFW_KEY_ESCAPE, 0, GLFW.GLFW_RELEASE, 0);
                pressedScreen[0] = screen;
                frame[1] = frame[0];
                escapes[0]++;
                if (mc.screen == null) {
                    return true;
                }
            }
            return Wait.pending(obj("screen", mc.screen == null ? null : mc.screen.getClass().getName(),
                "closesOnEsc", closesOnEsc, "escapes", escapes[0]));
        }).thenApply(result -> obj("closed", true, "dismissed", escapes[0] > 0, "initialScreen", initial, "escapes", escapes[0],
            "elapsedMs", result.elapsedMs()));
    }
}
