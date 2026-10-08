package blockwright.minecraft.core.client;

import blockwright.minecraft.core.Fail;
import dev.blockwright.api.Context;

import java.util.Locale;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.player.LocalPlayer;

/**
 * Reaching the client from task code: the game, its player and screen, each failing with the prefab's codes
 * when missing, and enum arguments by their wire names. How an action finishes (after a client tick, after a
 * server round trip) is {@link Settle}'s. Client instances only (this package names client classes).
 */
public final class ClientGame {
    private ClientGame() {
    }

    public static Minecraft mc(Context ctx) {
        Object client = ctx.client();
        if (client == null) {
            throw Fail.unavailable("this task needs a client, and this instance is a dedicated server");
        }
        return (Minecraft) client;
    }

    /** The local player; ends {@code unavailable} when the client is not in a world. */
    public static LocalPlayer player(Minecraft mc, String action) {
        if (mc.player == null || mc.level == null || mc.gameMode == null) {
            throw Fail.unavailable("the client is not in a world; cannot " + action);
        }
        return mc.player;
    }

    /** The open screen; ends {@code unavailable} when none is open. */
    public static Screen screen(Minecraft mc, String action) {
        if (mc.screen == null) {
            throw Fail.unavailable("no screen is open; cannot " + action);
        }
        return mc.screen;
    }

    /** {@code value} ({@code main-hand}, {@code MAIN_HAND}, ...) as a constant of {@code type}. */
    public static <E extends Enum<E>> E constant(Class<E> type, String value, String name) {
        try {
            return Enum.valueOf(type, value.trim().replace('-', '_').toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException unknown) {
            StringBuilder names = new StringBuilder();
            for (E constant : type.getEnumConstants()) {
                names.append(names.length() == 0 ? "" : ", ").append(constant.name().toLowerCase(Locale.ROOT).replace('_', '-'));
            }
            throw Fail.invalid(name + " must be one of " + names + "; got " + value);
        }
    }

    public static String lower(Enum<?> constant) {
        return constant.name().toLowerCase(Locale.ROOT).replace('_', '-');
    }

    /** The class name of what is open, or null. */
    public static String screenClass(Minecraft mc) {
        return mc.screen == null ? null : mc.screen.getClass().getName();
    }
}
