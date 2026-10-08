package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.GameJson;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Values;

import dev.blockwright.api.Context;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerTickRateManager;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * Reads of the server's world, one task entry point per query. Every entry point runs on the server thread
 * (the templates ask for it), takes the run's {@link Args}, and answers JSON-ready values in the shapes of
 * {@code src/world/types.ts}. None of them stamps: they only read.
 *
 * <p>{@code dimension} (optional everywhere) names a level, {@code minecraft:} implied; omitted, a query
 * about one place reads the overworld, and {@link #entities}/{@link #entity} search every level.
 */
public final class WorldQueries {
    private WorldQueries() {
    }

    /** {@code {tick, gameTime, frozen, sprinting, tickRate, worlds: [{dimension, players, entities, loadedChunks}], playerCount, maxPlayers, version, motd}}. */
    public static Object status(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        List<Object> worlds = new ArrayList<>();
        for (ServerLevel level : server.getAllLevels()) {
            worlds.add(obj("dimension", Levels.dimension(level), "players", level.players().size(),
                "entities", count(level.getAllEntities()), "loadedChunks", level.getChunkSource().getLoadedChunksCount()));
        }
        ServerTickRateManager ticks = server.tickRateManager();
        return obj(
            "tick", server.getTickCount(),
            "gameTime", server.overworld().getGameTime(),
            "frozen", ticks.isFrozen(),
            "sprinting", ticks.isSprinting(),
            "tickRate", ticks.tickrate(),
            "worlds", worlds,
            "worldCount", worlds.size(),
            "playerCount", server.getPlayerCount(),
            "maxPlayers", server.getMaxPlayers(),
            "version", server.getServerVersion(),
            "motd", server.getMotd());
    }

    /** The dimension ids, overworld first. */
    public static Object dimensions(Context ctx, Args args) {
        List<Object> dimensions = new ArrayList<>();
        for (ServerLevel level : Levels.requireServer(ctx).getAllLevels()) {
            dimensions.add(Levels.dimension(level));
        }
        return dimensions;
    }

    /** {@code {dimension, gameTime, dayTime, day, timeOfDay}}. */
    public static Object time(Context ctx, Args args) {
        ServerLevel level = level(ctx, args);
        long dayTime = level.getDayTime();
        return obj("dimension", Levels.dimension(level), "gameTime", level.getGameTime(), "dayTime", dayTime,
            "day", dayTime / 24000L, "timeOfDay", dayTime % 24000L);
    }

    /** Every online player as {@code GameJson.player} plus {@code gameMode} and {@code op}. */
    public static Object players(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        List<Object> players = new ArrayList<>();
        for (ServerPlayer player : server.getPlayerList().getPlayers()) {
            Map<String, Object> json = GameJson.player(player);
            json.put("gameMode", player.gameMode.getGameModeForPlayer().getName());
            json.put("op", server.getPlayerList().isOp(player.getGameProfile()));
            players.add(json);
        }
        return players;
    }

    /** {@code {ruleId: serializedValue}} of the level's game rules (shared by all levels of a server). */
    public static Object gamerules(Context ctx, Args args) {
        ServerLevel level = level(ctx, args);
        Map<String, Object> rules = new LinkedHashMap<>();
        GameRules gameRules = level.getGameRules();
        GameRules.visitGameRuleTypes(new GameRules.GameRuleTypeVisitor() {
            @Override
            public <T extends GameRules.Value<T>> void visit(GameRules.Key<T> key, GameRules.Type<T> type) {
                rules.put(key.getId(), gameRules.getRule(key).serialize());
            }
        });
        return rules;
    }

    /** {@code {dimension, pos, biome}} with the biome's registry id. */
    public static Object biome(Context ctx, Args args) {
        ServerLevel level = level(ctx, args);
        BlockPos pos = args.blockPos("pos");
        return obj("dimension", Levels.dimension(level), "pos", GameJson.pos(pos),
            "biome", level.getBiome(pos).getRegisteredName());
    }

    /** {@code {dimension, pos, chunkX, chunkZ, loaded, status?, inhabitedTime?, blockEntities?, gameTime}}; never loads a chunk. */
    public static Object chunk(Context ctx, Args args) {
        ServerLevel level = level(ctx, args);
        BlockPos pos = args.blockPos("pos");
        int chunkX = Math.floorDiv(pos.getX(), 16);
        int chunkZ = Math.floorDiv(pos.getZ(), 16);
        LevelChunk chunk = loadedChunk(level, chunkX, chunkZ);
        Map<String, Object> json = obj("dimension", Levels.dimension(level), "pos", GameJson.pos(pos),
            "chunkX", chunkX, "chunkZ", chunkZ, "loaded", chunk != null);
        if (chunk != null) {
            json.put("status", String.valueOf(chunk.getPersistedStatus()));
            json.put("inhabitedTime", chunk.getInhabitedTime());
            json.put("blockEntities", chunk.getBlockEntities().size());
        }
        json.put("gameTime", level.getGameTime());
        return json;
    }

    /** {@code GameJson.blockAt}; {@code nbt} adds the block entity's saved data. */
    public static Object block(Context ctx, Args args) {
        return GameJson.blockAt(level(ctx, args), args.blockPos("pos"), args.flag("nbt", false));
    }

    /** {@code GameJson.container}. */
    public static Object container(Context ctx, Args args) {
        return GameJson.container(level(ctx, args), args.blockPos("pos"), args.flag("nbt", false));
    }

    /**
     * The player ({@code player}, else the first one) and the containers within {@code radius} blocks of it (a
     * cube, loaded chunks only, at most {@code limit}): {@code {player: GameJson.player | null,
     * containers: [GameJson.container]}}. Failure evidence reads this.
     */
    public static Object nearPlayer(Context ctx, Args args) {
        int radius = (int) args.integer("radius", 0, 64, 8);
        int limit = (int) args.integer("limit", 1, 256, 16);
        Player player = Levels.player(ctx, args.string("player", null));
        List<Object> containers = new ArrayList<>();
        if (player == null) {
            return obj("player", null, "containers", containers);
        }
        Level level = player.level();
        BlockPos center = player.blockPosition();
        scan:
        for (int cx = (center.getX() - radius) >> 4; cx <= (center.getX() + radius) >> 4; cx++) {
            for (int cz = (center.getZ() - radius) >> 4; cz <= (center.getZ() + radius) >> 4; cz++) {
                LevelChunk chunk = level.getChunkSource().getChunkNow(cx, cz);
                if (chunk == null) {
                    continue;
                }
                for (BlockPos pos : new ArrayList<>(chunk.getBlockEntities().keySet())) {
                    if (Math.abs(pos.getX() - center.getX()) > radius || Math.abs(pos.getY() - center.getY()) > radius
                        || Math.abs(pos.getZ() - center.getZ()) > radius) {
                        continue;
                    }
                    Map<String, Object> json = GameJson.container(level, pos, false);
                    if (Boolean.TRUE.equals(json.get("isContainer"))) {
                        containers.add(json);
                    }
                    if (containers.size() >= limit) {
                        break scan;
                    }
                }
            }
        }
        return obj("player", GameJson.player(player), "containers", containers);
    }

    /** See {@link Region}. */
    public static Object region(Context ctx, Args args) {
        return Region.read(level(ctx, args), args.blockPos("min"), args.blockPos("max"), args.flag("cells", false),
            args.flag("states", false));
    }

    /**
     * Entities matching an {@link EntityFilter}, in one level ({@code dimension}) or all of them:
     * {@code {entities: [GameJson.entity + nbt?], count, scanned, limited, nbtTruncated?}}.
     */
    public static Object entities(Context ctx, Args args) {
        EntityFilter filter = EntityFilter.of(args);
        Values.Limits limits = Values.Limits.of(args.object("nbtLimits"), Values.Limits.NBT);
        List<Object> entities = new ArrayList<>();
        int scanned = 0;
        boolean limited = false;
        boolean nbtTruncated = false;
        scan:
        for (ServerLevel level : levels(ctx, args)) {
            for (Entity entity : level.getAllEntities()) {
                scanned++;
                if (!filter.matches(entity)) {
                    continue;
                }
                if (entities.size() >= filter.limit()) {
                    limited = true;
                    break scan;
                }
                Map<String, Object> json = GameJson.entity(entity);
                if (filter.includeNbt()) {
                    Values walker = new Values(limits);
                    json.put("nbt", GameJson.entityNbt(entity, filter.nbtPath(), walker, false));
                    nbtTruncated |= walker.truncated();
                }
                entities.add(json);
            }
        }
        Map<String, Object> result = obj("entities", entities, "count", entities.size(), "scanned", scanned,
            "limited", limited);
        if (filter.includeNbt()) {
            result.put("nbtTruncated", nbtTruncated);
        }
        return result;
    }

    /**
     * One entity by {@code id} or {@code uuid}: {@code {entity, nbt?, nbtTruncated?, inventory?}}, or null
     * when no level has it. {@code nbtPath} naming nothing ends the run {@code not-found}.
     */
    public static Object entity(Context ctx, Args args) {
        Entity entity = Levels.findEntity(ctx, args);
        if (entity == null) {
            return obj("found", false);
        }
        String nbtPath = args.string("nbtPath", null);
        boolean includeNbt = args.flag("nbt", false) || (nbtPath != null && !nbtPath.isBlank());
        Map<String, Object> result = obj("found", true, "entity", GameJson.entity(entity));
        if (includeNbt) {
            Values walker = new Values(Values.Limits.of(args.object("nbtLimits"), Values.Limits.NBT));
            result.put("nbt", GameJson.entityNbt(entity, nbtPath, walker, true));
            result.put("nbtTruncated", walker.truncated());
        }
        if (args.flag("inventory", false)) {
            result.put("inventory", GameJson.inventory(entity));
        }
        return result;
    }

    /** The level {@code args.dimension} names, the overworld when absent. */
    public static ServerLevel level(Context ctx, Args args) {
        return Levels.serverLevel(Levels.requireServer(ctx), args.string("dimension", null));
    }

    /** The level {@code args.dimension} names, or every level when absent. */
    public static Iterable<ServerLevel> levels(Context ctx, Args args) {
        String dimension = args.string("dimension", null);
        MinecraftServer server = Levels.requireServer(ctx);
        return dimension == null || dimension.isBlank() ? server.getAllLevels() : List.of(Levels.serverLevel(server, dimension));
    }

    static LevelChunk loadedChunk(ServerLevel level, int chunkX, int chunkZ) {
        return level.getChunkSource().hasChunk(chunkX, chunkZ) ? level.getChunk(chunkX, chunkZ) : null;
    }

    static int count(Iterable<?> items) {
        int count = 0;
        for (Object ignored : items) {
            count++;
        }
        return count;
    }
}
