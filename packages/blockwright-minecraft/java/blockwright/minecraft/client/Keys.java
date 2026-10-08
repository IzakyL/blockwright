package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.client.ClientGame;
import blockwright.minecraft.core.client.HeldKeys;
import blockwright.minecraft.core.client.Settle;
import dev.blockwright.api.Context;
import dev.blockwright.api.access.KeyboardHandlerAccessor;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import com.mojang.blaze3d.platform.InputConstants;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import org.lwjgl.glfw.GLFW;

/**
 * Keyboard input through the game's own handlers: keybinds by name (whatever key or button they are bound
 * to), raw GLFW keys through {@code KeyboardHandler.keyPress}, text through {@code charTyped}, and modifier
 * keys that read as held ({@link HeldKeys}) while an event is dispatched — screens ask GLFW
 * ({@code Screen.hasShiftDown}) rather than read the event's modifier bits. Client thread.
 */
public final class Keys {
    private Keys() {
    }

    // ---- held keys (see HeldKeys) ----

    /** {@code modifiers} as GLFW bits, from a number or a list of names ({@code shift}, {@code ctrl}, {@code alt}, {@code super}). */
    public static int modifiers(Args args) {
        Object value = args.value("modifiers");
        if (value == null) {
            return 0;
        }
        if (value instanceof List<?> names) {
            int bits = 0;
            for (Object name : names) {
                bits |= switch (String.valueOf(name).toLowerCase(Locale.ROOT)) {
                    case "shift" -> GLFW.GLFW_MOD_SHIFT;
                    case "ctrl", "control" -> GLFW.GLFW_MOD_CONTROL;
                    case "alt" -> GLFW.GLFW_MOD_ALT;
                    case "super", "meta", "cmd" -> GLFW.GLFW_MOD_SUPER;
                    default -> throw Fail.invalid("modifiers: unknown modifier " + name + " (shift, ctrl, alt, super)");
                };
            }
            return bits;
        }
        return (int) args.integer("modifiers", 0, 0xFF, 0);
    }

    // ---- keybinds ----

    /** A key mapping by its name ({@code key.jump}) or its {@code Options} field ({@code keyJump}); null if none. */
    public static KeyMapping findKeyMapping(Minecraft mc, String keybind) {
        for (KeyMapping mapping : mc.options.keyMappings) {
            if (keybind.equals(mapping.getName())) {
                return mapping;
            }
        }
        for (Field field : mc.options.getClass().getFields()) {
            try {
                if (keybind.equals(field.getName()) && field.get(mc.options) instanceof KeyMapping mapping) {
                    return mapping;
                }
            } catch (IllegalAccessException ignored) {
                // not a readable field
            }
        }
        return null;
    }

    /**
     * Presses or releases whatever {@code keybind} is bound to: a keyboard key through
     * {@code KeyboardHandler.keyPress}, a mouse button through {@code MouseHandler.onPress}.
     */
    public static Map<String, Object> keybind(Minecraft mc, String keybind, boolean pressed, int modifiers) {
        KeyMapping mapping = findKeyMapping(mc, keybind);
        if (mapping == null) {
            List<String> names = new ArrayList<>();
            for (KeyMapping each : mc.options.keyMappings) {
                if (each.getName().contains(keybind.replace("key.", "")) && names.size() < 8) {
                    names.add(each.getName());
                }
            }
            throw Fail.notFound("unknown keybind " + keybind + (names.isEmpty() ? "" : "; similar: " + names));
        }
        InputConstants.Key key = mapping.getKey();
        InputConstants.Type type = key.getType();
        boolean unbound = key.getValue() == InputConstants.UNKNOWN.getValue();
        if (unbound) {
            throw Fail.invalid("keybind " + keybind + " is not bound to any key, so pressing it would do nothing");
        }
        boolean screenOpen = mc.screen != null;
        Map<String, Object> result = obj(
            "keybind", keybind,
            "mapping", mapping.getName(),
            "pressed", pressed,
            "keyType", type.name().toLowerCase(Locale.ROOT),
            "key", key.getName(),
            "screen", ClientGame.screenClass(mc));
        if (type == InputConstants.Type.MOUSE) {
            result.put("dispatch", Mouse.button(mc, key.getValue(), pressed ? GLFW.GLFW_PRESS : GLFW.GLFW_RELEASE, modifiers));
        } else {
            int keysym = type == InputConstants.Type.KEYSYM ? key.getValue() : InputConstants.UNKNOWN.getValue();
            int scancode = type == InputConstants.Type.SCANCODE ? key.getValue() : 0;
            HeldKeys.holding(modifiers, () -> mc.keyboardHandler.keyPress(mc.getWindow().getWindow(), keysym, scancode,
                pressed ? GLFW.GLFW_PRESS : GLFW.GLFW_RELEASE, modifiers));
        }
        result.put("screenOpen", screenOpen);
        return result;
    }

    // ---- raw keys ----

    public static int keyAction(String action) {
        return switch (action == null ? "" : action.trim().toLowerCase(Locale.ROOT)) {
            case "press" -> GLFW.GLFW_PRESS;
            case "release" -> GLFW.GLFW_RELEASE;
            case "repeat" -> GLFW.GLFW_REPEAT;
            default -> throw Fail.invalid("key action must be press, release or repeat; got " + action);
        };
    }

    /** One GLFW key event through {@code KeyboardHandler.keyPress}, modifiers held while it is dispatched. */
    public static Map<String, Object> raw(Minecraft mc, int keyCode, int scanCode, int action, int modifiers) {
        String screen = ClientGame.screenClass(mc);
        HeldKeys.holding(modifiers, () -> mc.keyboardHandler.keyPress(mc.getWindow().getWindow(), keyCode, scanCode, action, modifiers));
        return obj(
            "keyCode", keyCode,
            "scanCode", scanCode,
            "action", action == GLFW.GLFW_PRESS ? "press" : action == GLFW.GLFW_RELEASE ? "release" : "repeat",
            "modifiers", modifiers,
            "screen", screen,
            "screenAfter", ClientGame.screenClass(mc));
    }

    /** Text typed into whatever has focus on the open screen, one code point at a time. */
    public static Map<String, Object> type(Minecraft mc, String text) {
        String screen = ClientGame.screen(mc, "type text").getClass().getName();
        long window = mc.getWindow().getWindow();
        KeyboardHandlerAccessor keyboard = (KeyboardHandlerAccessor) mc.keyboardHandler;
        int sent = 0;
        for (int offset = 0; offset < text.length(); ) {
            int codepoint = text.codePointAt(offset);
            offset += Character.charCount(codepoint);
            keyboard.blockwright$charTyped(window, codepoint, 0);
            sent++;
        }
        return obj("text", text, "codepoints", sent,
            "screen", screen);
    }

    // ---- the task entry point ----

    /**
     * One key input, as the {@code key} task asks: {@code {text}} types; {@code {keybind, action}} or
     * {@code {keyCode, scanCode?, modifiers?, action}} presses, releases or (action {@code tap}, the default)
     * both. A tap of a keybind, or of a raw key while no screen is open, then waits one client tick so the
     * game has acted on it (keybind clicks are consumed in the client tick).
     */
    public static Object key(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        if (args.has("text")) {
            return type(mc, args.string("text"));
        }
        String action = args.string("action", "tap").toLowerCase(Locale.ROOT);
        int modifiers = modifiers(args);
        if (args.has("keybind")) {
            String keybind = args.string("keybind");
            return switch (action) {
                case "press" -> keybind(mc, keybind, true, modifiers);
                case "release" -> keybind(mc, keybind, false, modifiers);
                case "tap" -> {
                    Map<String, Object> pressed = keybind(mc, keybind, true, modifiers);
                    Map<String, Object> released = keybind(mc, keybind, false, modifiers);
                    released.put("tap", true);
                    released.put("press", pressed);
                    yield Settle.afterTick(ctx, released);
                }
                default -> throw Fail.invalid("key action must be tap, press or release; got " + action);
            };
        }
        if (!args.has("keyCode")) {
            throw Fail.invalid("key needs text, keybind or keyCode");
        }
        int keyCode = (int) args.integer("keyCode", -1, GLFW.GLFW_KEY_LAST, 0);
        int scanCode = (int) args.integer("scanCode", 0, Integer.MAX_VALUE, 0);
        if (!action.equals("tap")) {
            return raw(mc, keyCode, scanCode, keyAction(action), modifiers);
        }
        boolean screenOpen = mc.screen != null;
        Map<String, Object> pressed = raw(mc, keyCode, scanCode, GLFW.GLFW_PRESS, modifiers);
        Map<String, Object> released = raw(mc, keyCode, scanCode, GLFW.GLFW_RELEASE, modifiers);
        released.put("tap", true);
        released.put("press", pressed);
        return screenOpen ? released : Settle.afterTick(ctx, released);
    }
}
