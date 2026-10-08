package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.GameJson;
import blockwright.minecraft.core.Levels;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * A box of blocks (at most {@link #MAX_VOLUME}) read without loading chunks: counts per block id, a palette,
 * and optionally one palette index per cell (x fastest, then z, then y). Blocks in unloaded chunks read as
 * {@link #UNLOADED}. With {@code states}, palette entries carry block state properties ({@code id[k=v,...]}).
 */
public final class Region {
    public static final int MAX_VOLUME = 32768;
    public static final String UNLOADED = "blockwright:unloaded";

    private Region() {
    }

    public static Map<String, Object> read(ServerLevel level, BlockPos a, BlockPos b, boolean withCells, boolean withStates) {
        BlockPos min = new BlockPos(Math.min(a.getX(), b.getX()), Math.min(a.getY(), b.getY()), Math.min(a.getZ(), b.getZ()));
        BlockPos max = new BlockPos(Math.max(a.getX(), b.getX()), Math.max(a.getY(), b.getY()), Math.max(a.getZ(), b.getZ()));
        long sizeX = (long) max.getX() - min.getX() + 1;
        long sizeY = (long) max.getY() - min.getY() + 1;
        long sizeZ = (long) max.getZ() - min.getZ() + 1;
        long volume = sizeX * sizeY * sizeZ;
        if (volume > MAX_VOLUME) {
            throw Fail.invalid("region volume must be " + MAX_VOLUME + " blocks or fewer, got " + volume);
        }
        Map<Long, LevelChunk> chunks = new HashMap<>();
        Map<BlockState, String[]> entries = new IdentityHashMap<>();
        Map<String, Integer> palette = new LinkedHashMap<>();
        Map<String, Integer> counts = new HashMap<>();
        List<Object> cells = withCells ? new ArrayList<>((int) volume) : null;
        BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
        for (int y = min.getY(); y <= max.getY(); y++) {
            for (int z = min.getZ(); z <= max.getZ(); z++) {
                for (int x = min.getX(); x <= max.getX(); x++) {
                    int chunkX = Math.floorDiv(x, 16);
                    int chunkZ = Math.floorDiv(z, 16);
                    long key = ((long) chunkX << 32) ^ (chunkZ & 0xffffffffL);
                    LevelChunk chunk = chunks.computeIfAbsent(key, unused -> WorldQueries.loadedChunk(level, chunkX, chunkZ));
                    String id = UNLOADED;
                    String entry = UNLOADED;
                    if (chunk != null) {
                        String[] cached = entries.computeIfAbsent(chunk.getBlockState(cursor.set(x, y, z)), state -> {
                            String stateId = GameJson.blockId(state);
                            return new String[] {stateId, withStates ? stateKey(stateId, String.valueOf(state)) : stateId};
                        });
                        id = cached[0];
                        entry = cached[1];
                    }
                    counts.merge(id, 1, Integer::sum);
                    int index = palette.computeIfAbsent(entry, unused -> palette.size());
                    if (cells != null) {
                        cells.add(index);
                    }
                }
            }
        }
        Map<String, Object> sortedCounts = new LinkedHashMap<>();
        counts.entrySet().stream()
            .sorted((left, right) -> right.getValue() - left.getValue())
            .forEach(each -> sortedCounts.put(each.getKey(), each.getValue()));
        Map<String, Object> result = obj(
            "dimension", Levels.dimension(level),
            "min", GameJson.pos(min),
            "max", GameJson.pos(max),
            "size", obj("x", sizeX, "y", sizeY, "z", sizeZ),
            "volume", volume,
            "counts", sortedCounts,
            "palette", new ArrayList<>(palette.keySet()));
        if (cells != null) {
            result.put("cells", cells);
        }
        return result;
    }

    private static String stateKey(String id, String state) {
        int properties = state.indexOf('[');
        return properties < 0 ? id : id + state.substring(properties);
    }
}
