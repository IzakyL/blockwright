package blockwright.minecraft.core.client;

import dev.blockwright.api.Hooks;
import dev.blockwright.api.Registration;

import java.util.function.IntPredicate;

import org.lwjgl.glfw.GLFW;

/**
 * Keys that read as held while an event is dispatched, on the {@link Hooks#KEY_DOWN} slot: screens ask GLFW
 * ({@code Screen.hasShiftDown}, {@code InputConstants.isKeyDown}) rather than read an event's modifier bits,
 * so a synthetic shift-click must also make shift read as down. The claim lasts exactly the dispatch.
 * Client thread.
 */
public final class HeldKeys {
    private HeldKeys() {
    }

    /** Whether GLFW key {@code key} is one of the modifiers in the bit set {@code modifiers}. */
    public static boolean isModifierHeld(int modifiers, int key) {
        return switch (key) {
            case GLFW.GLFW_KEY_LEFT_SHIFT, GLFW.GLFW_KEY_RIGHT_SHIFT -> (modifiers & GLFW.GLFW_MOD_SHIFT) != 0;
            case GLFW.GLFW_KEY_LEFT_CONTROL, GLFW.GLFW_KEY_RIGHT_CONTROL -> (modifiers & GLFW.GLFW_MOD_CONTROL) != 0;
            case GLFW.GLFW_KEY_LEFT_ALT, GLFW.GLFW_KEY_RIGHT_ALT -> (modifiers & GLFW.GLFW_MOD_ALT) != 0;
            case GLFW.GLFW_KEY_LEFT_SUPER, GLFW.GLFW_KEY_RIGHT_SUPER -> (modifiers & GLFW.GLFW_MOD_SUPER) != 0;
            default -> false;
        };
    }

    /**
     * Runs {@code dispatch} with the modifier keys in {@code modifiers} (GLFW bits: shift 1, control 2, alt 4,
     * super 8) and the GLFW keys in {@code keys} reading as held; without any, it just runs.
     */
    public static void holding(int modifiers, int[] keys, Runnable dispatch) {
        if (modifiers == 0 && (keys == null || keys.length == 0)) {
            dispatch.run();
            return;
        }
        int[] extra = keys == null ? new int[0] : keys;
        IntPredicate held = key -> {
            if (isModifierHeld(modifiers, key)) {
                return true;
            }
            for (int each : extra) {
                if (each == key) {
                    return true;
                }
            }
            return false;
        };
        try (Registration claim = Hooks.KEY_DOWN.claim(held)) {
            dispatch.run();
        }
    }

    public static void holding(int modifiers, Runnable dispatch) {
        holding(modifiers, null, dispatch);
    }
}
