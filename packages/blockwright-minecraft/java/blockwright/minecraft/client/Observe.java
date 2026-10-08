package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Reflection;
import blockwright.minecraft.core.client.ClientGame;
import dev.blockwright.api.Context;
import dev.blockwright.api.TaskException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

import net.minecraft.client.Minecraft;

/**
 * One look at the client, read in a single client-thread turn so every section describes the same frame:
 * {@code screen}, {@code player}, {@code cursor}, {@code hudText}, {@code messages}, {@code nearby}, plus any
 * reflect {@code queries}. A section that cannot be read is null and its reason is listed in {@code errors}
 * instead of failing the whole look. Each section is on unless its argument is {@code false}
 * ({@code messages} takes a count, {@code nearby} an object {@code {radius, limit}}).
 */
public final class Observe {
    private Observe() {
    }

    public static Map<String, Object> observe(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Map<String, Object> result = new LinkedHashMap<>();
        List<Object> errors = new ArrayList<>();
        if (args.flag("screen", true)) {
            section(result, errors, "screen", () -> Screens.info(mc));
        }
        if (args.flag("player", true)) {
            section(result, errors, "player", () -> ClientState.player(mc));
        }
        if (args.flag("cursor", true)) {
            section(result, errors, "cursor", () -> ClientState.cursor(mc));
        }
        if (args.flag("hudText", true)) {
            section(result, errors, "hudText", () -> ClientState.hudText(mc));
        }
        long messages = args.value("messages") instanceof Boolean flag ? (flag ? 10 : 0)
            : args.integer("messages", 0, 100_000, 10);
        if (messages > 0) {
            section(result, errors, "messages", () -> ClientState.messages(mc, (int) messages));
        }
        Object nearby = args.value("nearby");
        if (!Boolean.FALSE.equals(nearby)) {
            Args spec = nearby instanceof Map<?, ?> ? args.object("nearby") : Args.of(null, "nearby");
            section(result, errors, "nearby", () -> mc.player == null ? null
                : ClientState.nearby(mc, spec.number("radius", 16), (int) spec.integer("limit", 0, 100_000, 10)));
        }
        Args queries = args.object("queries");
        if (queries != null) {
            Map<String, Object> extra = new LinkedHashMap<>();
            for (String name : queries.raw().keySet()) {
                try {
                    extra.put(name, obj("ok", Reflection.query(ctx, queries.requireObject(name))));
                } catch (TaskException failure) {
                    extra.put(name, obj("error", obj("code", failure.code(), "message", failure.getMessage())));
                    errors.add(name + ": " + failure.getMessage());
                }
            }
            result.put("queries", extra);
        }
        result.put("errors", errors);
        return result;
    }

    private static void section(Map<String, Object> result, List<Object> errors, String name, Callable<Object> read) {
        try {
            result.put(name, read.call());
        } catch (Exception | LinkageError failure) {
            result.put(name, null);
            errors.add(name + ": " + (failure.getMessage() == null ? failure.toString() : failure.getMessage()));
        }
    }
}
