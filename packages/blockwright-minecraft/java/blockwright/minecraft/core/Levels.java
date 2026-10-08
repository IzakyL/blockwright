package blockwright.minecraft.core;

import dev.blockwright.api.Context;

import java.lang.reflect.Field;
import java.util.List;
import java.util.UUID;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.AABB;

/**
 * Finding levels and players from code that must also link on a dedicated server: the client's level and
 * player are reached reflectively, so this class names no client class. Reading a server level belongs on
 * the server thread, the client's on the client thread.
 */
public final class Levels {
    private static final String MINECRAFT = "net.minecraft.client.Minecraft";

    private Levels() {
    }

    /** A level's dimension id, e.g. {@code minecraft:overworld}. */
    public static String dimension(Level level) {
        return level.dimension().location().toString();
    }

    /** A dimension id as a caller names it, namespaced; also accepts a ResourceKey's toString. */
    public static String normalizeDimension(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.startsWith("ResourceKey[")) {
            int slash = normalized.lastIndexOf(" / ");
            if (slash >= 0 && normalized.endsWith("]")) {
                normalized = normalized.substring(slash + 3, normalized.length() - 1);
            }
        }
        return normalized.contains(":") ? normalized : "minecraft:" + normalized;
    }

    /** The server this instance runs; ends {@code unavailable} when it runs none (a client of a remote server). */
    public static MinecraftServer requireServer(Context ctx) {
        MinecraftServer server = ctx.server();
        if (server == null) {
            throw Fail.unavailable("this instance runs no server");
        }
        return server;
    }

    /**
     * The levels a query about {@code dimension} searches: that one level, or, when null or blank, every server
     * level (where a server runs in this process) or else the client's level. Ends {@code unavailable} when
     * there is no level at all.
     */
    public static List<? extends Level> levels(Context ctx, String dimension) {
        MinecraftServer server = ctx.server();
        if (dimension != null && !dimension.isBlank()) {
            return List.of(level(ctx, dimension));
        }
        if (server != null) {
            List<Level> all = new java.util.ArrayList<>();
            server.getAllLevels().forEach(all::add);
            return all;
        }
        return List.of(level(ctx, null));
    }

    /**
     * The entity {@code args} names by {@code id} (network id) and/or {@code uuid}, searched in
     * {@code args.dimension} or in every level ({@link #levels}); the id wins when both are given and it is
     * found. Null when no level has it; ends {@code invalid} when neither is given or the uuid is malformed.
     */
    public static Entity findEntity(Context ctx, Args args) {
        if (!args.has("id") && !args.has("uuid")) {
            throw Fail.invalid("an entity needs id or uuid");
        }
        UUID uuid = args.has("uuid") ? uuid(args.string("uuid")) : null;
        Integer id = args.has("id") ? (int) args.integer("id") : null;
        for (Level level : levels(ctx, args.string("dimension", null))) {
            Entity entity = findEntity(level, id, uuid);
            if (entity != null) {
                return entity;
            }
        }
        return null;
    }

    /** The entity with network id {@code id} (when not null), else with {@code uuid} (when not null), in {@code level}. */
    public static Entity findEntity(Level level, Integer id, UUID uuid) {
        Entity entity = id != null ? level.getEntity(id) : null;
        return entity == null && uuid != null ? byUuid(level, uuid) : entity;
    }

    /** The entity with {@code uuid} in {@code level} (server or client), or null. */
    public static Entity byUuid(Level level, UUID uuid) {
        if (level instanceof ServerLevel server) {
            return server.getEntity(uuid);
        }
        AABB everywhere = new AABB(-3.0E7, level.getMinBuildHeight() - 64.0, -3.0E7, 3.0E7, level.getMaxBuildHeight() + 64.0, 3.0E7);
        List<Entity> found = level.getEntities((Entity) null, everywhere, entity -> uuid.equals(entity.getUUID()));
        return found.isEmpty() ? null : found.get(0);
    }

    /** {@code text} as a UUID; ends {@code invalid} when it is not one. */
    public static UUID uuid(String text) {
        try {
            return UUID.fromString(text);
        } catch (IllegalArgumentException malformed) {
            throw Fail.invalid("not a UUID: " + text);
        }
    }

    /** The server level of {@code dimension} (the overworld when null or blank); ends {@code not-found} otherwise. */
    public static ServerLevel serverLevel(MinecraftServer server, String dimension) {
        if (dimension == null || dimension.isBlank()) {
            return server.overworld();
        }
        String expected = normalizeDimension(dimension);
        for (ServerLevel level : server.getAllLevels()) {
            if (expected.equals(dimension(level))) {
                return level;
            }
        }
        throw Fail.notFound("server has no dimension " + expected);
    }

    /** The client's current level, or null (no client, or not in a world). Read it on the client thread. */
    public static Level clientLevel() {
        return (Level) clientField("level");
    }

    /** The client's local player, or null. Read it on the client thread. */
    public static Player clientPlayer() {
        return (Player) clientField("player");
    }

    /** {@code net.minecraft.client.Minecraft.getInstance()} as an Object, or null on a dedicated server. */
    public static Object minecraft() {
        try {
            Class<?> type = Class.forName(MINECRAFT, false, Levels.class.getClassLoader());
            return type.getMethod("getInstance").invoke(null);
        } catch (ClassNotFoundException dedicated) {
            return null;
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("cannot reach " + MINECRAFT + ".getInstance()", error);
        }
    }

    private static Object clientField(String name) {
        Object minecraft = minecraft();
        if (minecraft == null) {
            return null;
        }
        try {
            Field field = minecraft.getClass().getField(name);
            return field.get(minecraft);
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException("cannot read Minecraft." + name, error);
        }
    }

    /**
     * The level a task means: the server level of {@code dimension} where a server runs in this process,
     * else the client's level (which must be in {@code dimension} when one is named). Ends
     * {@code unavailable} when there is neither.
     */
    public static Level level(Context ctx, String dimension) {
        MinecraftServer server = ctx.server();
        if (server != null) {
            return serverLevel(server, dimension);
        }
        Level level = clientLevel();
        if (level == null) {
            throw Fail.unavailable("no level: this instance has no server, and its client is not in a world");
        }
        if (dimension != null && !dimension.isBlank() && !normalizeDimension(dimension).equals(dimension(level))) {
            throw Fail.notFound("the client is in " + dimension(level) + ", not " + normalizeDimension(dimension));
        }
        return level;
    }

    /**
     * A player by name (the first player when {@code name} is null): on the server from the player list,
     * on a client its local player (whose name must match when given). Null when there is none.
     */
    public static Player player(Context ctx, String name) {
        MinecraftServer server = ctx.server();
        if (server != null) {
            if (name == null || name.isBlank()) {
                return server.getPlayerList().getPlayers().isEmpty() ? null : server.getPlayerList().getPlayers().get(0);
            }
            return server.getPlayerList().getPlayerByName(name);
        }
        Player local = clientPlayer();
        if (local == null || name == null || name.isBlank() || local.getGameProfile().getName().equals(name)) {
            return local;
        }
        return null;
    }
}
