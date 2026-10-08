package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Wait;

import dev.blockwright.api.Context;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;

/**
 * Samples server performance in the game over {@code durationMs} (1..600000), one sample per
 * {@code sampleIntervalMs} (default 1000), taken at a server tick end on the server thread:
 * {@code {tick, gameTime, tps, gameTps, mspt, maxMspt, entityCount, loadedChunks, memoryMb}}. {@code tps} counts
 * server ticks per second (they run while frozen); {@code gameTps} counts world ticks (0 while frozen, above 20
 * while sprinting); {@code mspt}/{@code maxMspt} are the mean/max time the server spent in each tick since
 * the previous sample. The answer adds a summary {@code {avgMspt, p95Mspt, maxMspt, minTps, avgTps,
 * maxEntityCount}}. A server that stops ticking takes no samples.
 */
public final class Performance {
    private Performance() {
    }

    public static CompletableFuture<Object> sample(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        long durationMs = args.integer("durationMs", 1, 600_000, 5_000);
        long intervalMs = args.integer("sampleIntervalMs", 1, durationMs, Math.min(1_000, durationMs));
        ServerLevel level = WorldQueries.level(ctx, args);
        long started = System.nanoTime();
        long end = started + TimeUnit.MILLISECONDS.toNanos(durationMs);
        long interval = TimeUnit.MILLISECONDS.toNanos(intervalMs);
        List<Map<String, Object>> samples = new ArrayList<>();
        long[] previous = {started, server.getTickCount(), level.getGameTime()};
        long[] nextAt = {started + interval};

        return Wait.until(ctx, Wait.Clock.SERVER_TICK, new Wait.Options(0, 0, 0, false), () -> {
            long now = System.nanoTime();
            if (now >= nextAt[0] || now >= end) {
                samples.add(sampleSince(server, level, previous, now));
                nextAt[0] = now + interval;
            }
            return now >= end ? Boolean.TRUE : Wait.pending(samples.size());
        }).thenApply(done -> obj(
            "durationMs", durationMs,
            "sampleIntervalMs", intervalMs,
            "dimension", Levels.dimension(level),
            "samples", samples,
            "summary", summary(samples)));
    }

    private static Map<String, Object> sampleSince(MinecraftServer server, ServerLevel level, long[] previous, long now) {
        int tick = server.getTickCount();
        long gameTime = level.getGameTime();
        double seconds = Math.max(1e-9, (now - previous[0]) / 1e9);
        long ticks = tick - previous[1];
        long[] times = server.getTickTimesNanos();
        long total = 0;
        long max = 0;
        int counted = 0;
        for (long t = tick; t > previous[1] && counted < times.length; t--, counted++) {
            long nanos = times[(int) (t % times.length)];
            total += nanos;
            max = Math.max(max, nanos);
        }
        Map<String, Object> sample = obj(
            "tick", tick,
            "gameTime", gameTime,
            "tps", ticks / seconds,
            "gameTps", (gameTime - previous[2]) / seconds,
            "mspt", counted == 0 ? 0.0 : total / 1e6 / counted,
            "maxMspt", max / 1e6,
            "entityCount", WorldQueries.count(level.getAllEntities()),
            "loadedChunks", level.getChunkSource().getLoadedChunksCount(),
            "memoryMb", (Runtime.getRuntime().totalMemory() - Runtime.getRuntime().freeMemory()) / (1024L * 1024L));
        previous[0] = now;
        previous[1] = tick;
        previous[2] = gameTime;
        return sample;
    }

    private static Map<String, Object> summary(List<Map<String, Object>> samples) {
        List<Double> mspt = new ArrayList<>();
        double maxMspt = 0;
        double minTps = Double.POSITIVE_INFINITY;
        double tpsTotal = 0;
        int maxEntities = 0;
        for (Map<String, Object> sample : samples) {
            mspt.add((Double) sample.get("mspt"));
            maxMspt = Math.max(maxMspt, (Double) sample.get("maxMspt"));
            double tps = (Double) sample.get("tps");
            minTps = Math.min(minTps, tps);
            tpsTotal += tps;
            maxEntities = Math.max(maxEntities, (Integer) sample.get("entityCount"));
        }
        mspt.sort(Double::compareTo);
        double p95 = mspt.isEmpty() ? 0 : mspt.get(Math.min(mspt.size() - 1, Math.max(0, (int) Math.ceil(mspt.size() * 0.95) - 1)));
        return obj(
            "samples", samples.size(),
            "avgMspt", mspt.stream().mapToDouble(Double::doubleValue).average().orElse(0),
            "p95Mspt", p95,
            "maxMspt", maxMspt,
            "minTps", samples.isEmpty() ? 0 : minTps,
            "avgTps", samples.isEmpty() ? 0 : tpsTotal / samples.size(),
            "maxEntityCount", maxEntities);
    }
}
