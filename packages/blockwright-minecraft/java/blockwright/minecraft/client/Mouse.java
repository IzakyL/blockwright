package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Handles;
import blockwright.minecraft.core.Reflection;
import blockwright.minecraft.core.Wait;
import blockwright.minecraft.core.client.ClientGame;
import blockwright.minecraft.core.client.HeldKeys;
import blockwright.minecraft.core.client.Settle;
import dev.blockwright.api.Context;
import dev.blockwright.api.TaskException;
import dev.blockwright.api.access.MouseHandlerAccessor;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.mojang.blaze3d.platform.Window;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractButton;
import net.minecraft.client.gui.screens.Screen;
import org.lwjgl.glfw.GLFW;

/**
 * Mouse input sent the way GLFW would deliver it, through {@code MouseHandler}: the cursor (GUI-scaled
 * coordinates, the space screens and widgets use), buttons, scrolling and drags; modifier keys read as held
 * while an event is dispatched. Client thread.
 */
public final class Mouse {
    private Mouse() {
    }

    private static MouseHandlerAccessor handler(Minecraft mc) {
        return (MouseHandlerAccessor) mc.mouseHandler;
    }

    public static int buttonCode(String button) {
        return switch (button == null ? "left" : button.trim().toLowerCase(Locale.ROOT)) {
            case "left" -> GLFW.GLFW_MOUSE_BUTTON_LEFT;
            case "right" -> GLFW.GLFW_MOUSE_BUTTON_RIGHT;
            case "middle" -> GLFW.GLFW_MOUSE_BUTTON_MIDDLE;
            default -> throw Fail.invalid("mouse button must be left, right or middle; got " + button);
        };
    }

    public static String buttonName(int button) {
        return switch (button) {
            case GLFW.GLFW_MOUSE_BUTTON_LEFT -> "left";
            case GLFW.GLFW_MOUSE_BUTTON_RIGHT -> "right";
            case GLFW.GLFW_MOUSE_BUTTON_MIDDLE -> "middle";
            default -> "button" + button;
        };
    }

    public static int buttonAction(String action) {
        return switch (action == null ? "" : action.trim().toLowerCase(Locale.ROOT)) {
            case "press" -> GLFW.GLFW_PRESS;
            case "release" -> GLFW.GLFW_RELEASE;
            default -> throw Fail.invalid("mouse action must be press or release; got " + action);
        };
    }

    // ---- cursor ----

    private static double rawX(Window window, double scaledX) {
        return scaledX * window.getScreenWidth() / window.getGuiScaledWidth();
    }

    private static double rawY(Window window, double scaledY) {
        return scaledY * window.getScreenHeight() / window.getGuiScaledHeight();
    }

    /** Moves the OS cursor and MouseHandler's own copy (what screens read), in raw window pixels. */
    private static void setRaw(Minecraft mc, double rawX, double rawY) {
        GLFW.glfwSetCursorPos(mc.getWindow().getWindow(), rawX, rawY);
        handler(mc).blockwright$setXpos(rawX);
        handler(mc).blockwright$setYpos(rawY);
    }

    /** The cursor: GUI-scaled {@code x, y}, raw pixels, and the window's sizes and scale. */
    public static Map<String, Object> cursor(Minecraft mc) {
        Window window = mc.getWindow();
        double rawX = mc.mouseHandler.xpos();
        double rawY = mc.mouseHandler.ypos();
        return obj(
            "x", rawX * window.getGuiScaledWidth() / Math.max(1, window.getScreenWidth()),
            "y", rawY * window.getGuiScaledHeight() / Math.max(1, window.getScreenHeight()),
            "rawX", rawX,
            "rawY", rawY,
            "screenWidth", window.getScreenWidth(),
            "screenHeight", window.getScreenHeight(),
            "guiScaledWidth", window.getGuiScaledWidth(),
            "guiScaledHeight", window.getGuiScaledHeight(),
            "guiScale", window.getGuiScale());
    }

    /** Puts the cursor at GUI-scaled {@code (x, y)}; with a button held and a screen open this is a drag step. */
    public static Map<String, Object> move(Minecraft mc, double x, double y) {
        Window window = mc.getWindow();
        if (window.getScreenWidth() <= 0 || window.getScreenHeight() <= 0
            || window.getGuiScaledWidth() <= 0 || window.getGuiScaledHeight() <= 0) {
            throw Fail.unavailable("the window has no size, so there is nowhere to put the cursor");
        }
        boolean dragged = handler(mc).blockwright$activeButton() >= 0 && dragTo(mc, x, y);
        if (!dragged) {
            setRaw(mc, rawX(window, x), rawY(window, y));
        }
        Map<String, Object> result = obj("cursor", cursor(mc), "dragged", dragged);
        result.put("screen", ClientGame.screenClass(mc));
        return result;
    }

    /**
     * One drag step to GUI-scaled {@code (x, y)} with the active button held: the cursor moves and the
     * accumulated movement is handled the way the game does each frame ({@code mouseMoved} and
     * {@code mouseDragged} on the screen). An unfocused window makes the game skip that, so the screen is then
     * told directly. False when there is no screen or the cursor is already there.
     */
    private static boolean dragTo(Minecraft mc, double x, double y) {
        Screen screen = mc.screen;
        if (screen == null || mc.getOverlay() != null) {
            return false;
        }
        Window window = mc.getWindow();
        double previousX = mc.mouseHandler.xpos();
        double previousY = mc.mouseHandler.ypos();
        double rawX = rawX(window, x);
        double rawY = rawY(window, y);
        if (rawX == previousX && rawY == previousY) {
            return false;
        }
        setRaw(mc, rawX, rawY);
        if (mc.isWindowActive()) {
            handler(mc).blockwright$setAccumulatedDX(rawX - previousX);
            handler(mc).blockwright$setAccumulatedDY(rawY - previousY);
            mc.mouseHandler.handleAccumulatedMovement();
        } else {
            double dx = (rawX - previousX) * window.getGuiScaledWidth() / window.getScreenWidth();
            double dy = (rawY - previousY) * window.getGuiScaledHeight() / window.getScreenHeight();
            screen.mouseMoved(x, y);
            int active = handler(mc).blockwright$activeButton();
            if (active >= 0) {
                screen.mouseDragged(x, y, active, dx, dy);
            }
        }
        return true;
    }

    // ---- buttons ----

    /** One button event through {@code MouseHandler.onPress}, modifiers held; answers what it went through. */
    public static Map<String, Object> button(Minecraft mc, int button, int action, int modifiers) {
        List<Map<String, Object>> observed = new ArrayList<>(1);
        HeldKeys.holding(modifiers, () -> observed.add(InputWitness.watch(
            () -> handler(mc).blockwright$onPress(mc.getWindow().getWindow(), button, action, modifiers))));
        return observed.get(0);
    }

    /**
     * The {@code mouseButton} task: {@code {button, action, modifiers?, hovered?, observe?}}. A press may
     * carry {@code hovered: {root, within: [handles], timeoutMs?}}: right before dispatching, the object
     * {@code root} (a reflect root, usually a static path to what is under the cursor) resolves to must be
     * one of the {@code within} handles, else nothing is sent and the run ends {@code hover-mismatch}. With
     * {@code timeoutMs > 0} a mismatch is re-checked after every rendered frame (an earlier hover lingers
     * until the UI renders with the cursor here) and the press goes out once it matches; {@code hover-mismatch}
     * only when it still does not after that long. {@code observe} (a reflect query) is read right after
     * dispatch, in the same client-thread turn.
     */
    public static Object buttonTask(Context ctx, Args args) throws Exception {
        Minecraft mc = ClientGame.mc(ctx);
        int button = buttonCode(args.string("button", "left"));
        int action = buttonAction(args.string("action"));
        int modifiers = Keys.modifiers(args);
        Args hovered = args.object("hovered");
        if (hovered == null) {
            return dispatch(ctx, mc, args, button, action, modifiers);
        }
        long waitMs = hovered.integer("timeoutMs", 0, 600_000, 0);
        TaskException mismatch = hoverMismatch(ctx, hovered);
        if (mismatch == null) {
            return dispatch(ctx, mc, args, button, action, modifiers);
        }
        if (waitMs == 0) {
            throw mismatch;
        }
        TaskException[] last = {mismatch};
        return Wait.until(ctx, Wait.Clock.FRAME, new Wait.Options(waitMs, 0, 0, false), () -> {
            TaskException now = hoverMismatch(ctx, hovered);
            if (now != null) {
                last[0] = now;
                return Wait.pending(now.detail());
            }
            return dispatch(ctx, mc, args, button, action, modifiers);
        }).handle((result, failure) -> {
            if (failure == null) {
                return result.value();
            }
            Throwable cause = failure instanceof java.util.concurrent.CompletionException && failure.getCause() != null
                ? failure.getCause() : failure;
            if (cause instanceof TaskException task && Fail.WAIT_TIMEOUT.equals(task.code())) {
                TaskException stale = last[0];
                throw new TaskException(Fail.HOVER_MISMATCH, stale.getMessage() + " (still after " + waitMs + "ms)",
                    stale.detail());
            }
            throw cause instanceof RuntimeException runtime ? runtime : new java.util.concurrent.CompletionException(cause);
        });
    }

    private static Map<String, Object> dispatch(Context ctx, Minecraft mc, Args args, int button, int action,
            int modifiers) throws Exception {
        Map<String, Object> result = obj(
            "button", buttonName(button),
            "action", action == GLFW.GLFW_PRESS ? "press" : "release",
            "modifiers", modifiers,
            "screen", ClientGame.screenClass(mc));
        result.put("dispatch", button(mc, button, action, modifiers));
        result.put("screenAfter", ClientGame.screenClass(mc));
        Args observe = args.object("observe");
        if (observe != null) {
            Map<String, Object> query = new LinkedHashMap<>(observe.raw());
            query.putIfAbsent("handles", true);
            result.put("observed", Reflection.query(ctx, Args.of(query, "observe")));
        }
        return result;
    }

    /** Null when what {@code hovered.root} names is one of the {@code within} handles, else the failure to end with. */
    private static TaskException hoverMismatch(Context ctx, Args hovered) throws Exception {
        List<String> within = hovered.strings("within");
        if (within == null || within.isEmpty()) {
            throw Fail.invalid("hovered.within must be a non-empty array of handles");
        }
        Object target = Reflection.guard(() -> Reflection.resolveRoot(ctx, hovered.requireObject("root"), null,
            new LinkedHashMap<>()));
        if (target != null) {
            for (String handle : within) {
                if (Handles.resolve(handle) == target) {
                    return null;
                }
            }
        }
        return new TaskException(Fail.HOVER_MISMATCH, target == null
            ? "nothing is hovered, so no press was sent"
            : "the hovered " + target.getClass().getName() + " is not within the target, so no press was sent",
            target == null ? obj("hovered", null)
                : obj("hovered", obj("class", target.getClass().getName(), "handle", Handles.registerShared(target))));
    }

    /**
     * A click at GUI-scaled {@code (x, y)}: the cursor moves there, then {@code button} is pressed and
     * released ({@code double}: twice). With no screen open the click acts through the keybinds, which the
     * game reads in its next tick, so the answer comes after that tick.
     */
    public static Object click(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Map<String, Object> result = clickAt(mc, args.number("x"), args.number("y"),
            buttonCode(args.string("button", "left")), Keys.modifiers(args), args.flag("double", false) ? 2 : 1);
        return result.get("screen") != null ? result : Settle.afterTick(ctx, result);
    }

    /** {@link #click} without the wait: moves, then {@code count} press/release pairs. */
    public static Map<String, Object> clickAt(Minecraft mc, double x, double y, int button, int modifiers, int count) {
        Map<String, Object> moved = move(mc, x, y);
        boolean screenOpen = mc.screen != null;
        List<Object> presses = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            presses.add(obj("press", button(mc, button, GLFW.GLFW_PRESS, modifiers),
                "release", button(mc, button, GLFW.GLFW_RELEASE, modifiers)));
        }
        return obj(
            "x", x,
            "y", y,
            "button", buttonName(button),
            "modifiers", modifiers,
            "clicks", count,
            "cursor", moved.get("cursor"),
            "screen", screenOpen ? moved.get("screen") : null,
            "screenAfter", ClientGame.screenClass(mc),
            "dispatch", presses);
    }

    /**
     * A click on the open screen itself at {@code (x, y)} through {@code Screen.mouseClicked} and
     * {@code mouseReleased}, without moving the cursor or any OS-level event. When the screen does not handle
     * it and {@code handle} names a visible, active button, that button is pressed directly.
     */
    public static Map<String, Object> clickScreen(Minecraft mc, double x, double y, int button, String handle) {
        Screen screen = ClientGame.screen(mc, "click on it");
        Object widget = handle == null || handle.isBlank() ? null : Handles.resolve(handle);
        boolean clicked = screen.mouseClicked(x, y, button);
        boolean released = screen.mouseReleased(x, y, button);
        boolean handled = clicked || released;
        boolean pressed = false;
        if (!handled && widget instanceof AbstractButton pressable && pressable.visible && pressable.active) {
            pressable.onPress();
            handled = true;
            pressed = true;
        }
        return obj("handled", handled, "pressedButton", pressed, "x", x, "y", y,
            "button", buttonName(button), "screen", screen.getClass().getName(), "screenAfter", ClientGame.screenClass(mc));
    }

    // ---- scroll and drag ----

    /**
     * {@code count} (1..100, default 1) wheel events of {@code xOffset}/{@code yOffset} each through
     * {@code MouseHandler.onScroll}, in one client-thread turn, at the cursor or at {@code x}/{@code y} after
     * moving there. Several events are not one bigger event: screens that scroll a fixed step per event
     * (some UI libraries do) need the count.
     */
    public static Map<String, Object> scroll(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        double xOffset = args.number("xOffset", 0);
        double yOffset = args.number("yOffset", 0);
        if (xOffset == 0 && yOffset == 0) {
            throw Fail.invalid("scroll needs a non-zero xOffset or yOffset");
        }
        long count = args.integer("count", 1, 100, 1);
        int modifiers = Keys.modifiers(args);
        Map<String, Object> moved = args.has("x") && args.has("y") ? move(mc, args.number("x"), args.number("y")) : null;
        String screen = ClientGame.screenClass(mc);
        HeldKeys.holding(modifiers, () -> {
            for (long at = 0; at < count; at++) {
                handler(mc).blockwright$onScroll(mc.getWindow().getWindow(), xOffset, yOffset);
            }
        });
        return obj("xOffset", xOffset, "yOffset", yOffset,
            "count", count, "modifiers", modifiers, "cursor", moved == null ? cursor(mc) : moved.get("cursor"),
            "screen", screen);
    }

    /**
     * A drag on the open screen from {@code from} to {@code to} (GUI-scaled) in {@code steps} moves: press at
     * {@code from}, the moves, release at {@code to}, all in one client-thread turn.
     */
    public static Map<String, Object> drag(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        ClientGame.screen(mc, "drag on it");
        Args from = args.requireObject("from");
        Args to = args.requireObject("to");
        double fromX = from.number("x");
        double fromY = from.number("y");
        double toX = to.number("x");
        double toY = to.number("y");
        int steps = (int) args.integer("steps", 1, 256, 8);
        int button = buttonCode(args.string("button", "left"));
        int modifiers = Keys.modifiers(args);

        setRaw(mc, rawX(mc.getWindow(), fromX), rawY(mc.getWindow(), fromY));
        Map<String, Object> start = cursor(mc);
        Map<String, Object> press = button(mc, button, GLFW.GLFW_PRESS, modifiers);
        int active = handler(mc).blockwright$activeButton();
        boolean armed = active == button && handler(mc).blockwright$mousePressedTime() > 0;
        int[] dispatched = {0};
        HeldKeys.holding(modifiers, () -> {
            for (int step = 1; step <= steps; step++) {
                double t = (double) step / steps;
                if (dragTo(mc, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t)) {
                    dispatched[0]++;
                }
            }
        });
        Map<String, Object> end = cursor(mc);
        Map<String, Object> release = button(mc, button, GLFW.GLFW_RELEASE, modifiers);
        return obj(
            "from", start,
            "to", end,
            "button", buttonName(button),
            "modifiers", modifiers,
            "steps", steps,
            "dispatched", dispatched[0],
            "pressArmed", armed,
            "windowActive", mc.isWindowActive(),
            "press", press,
            "release", release,
            "screen", ClientGame.screenClass(mc));
    }
}
