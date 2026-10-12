package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Levels;

import dev.blockwright.api.Context;

import java.io.BufferedWriter;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.EventPriority;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/**
 * Keeps every server tick that ran the world, from {@link #start} until the game stops: the game time it ran,
 * when it began and how long it took, with nothing summed or dropped ({@link Performance} is the sampled view).
 * One row is {@code {gameTime, wallNs, fullNs, postNs, normalNs, epochMs}}:
 *
 * <ul>
 * <li>{@code wallNs}: {@code System.nanoTime()} at {@code ServerTickEvent.Pre} (HIGHEST);</li>
 * <li>{@code fullNs}: from there to the end of {@code ServerTickEvent.Post} (LOWEST), the whole tick with what
 *     mods do in its Post phase;</li>
 * <li>{@code postNs}: the Post phase alone;</li>
 * <li>{@code normalNs}: the NORMAL-priority band of Post (between this meter's HIGH and LOW listeners), where a
 *     mod listening at the default priority runs;</li>
 * <li>{@code epochMs}: {@code System.currentTimeMillis()} at Pre, to line rows up with a recording's wall clock.</li>
 * </ul>
 *
 * Ticks of a frozen world are not kept. The rows and the listeners live in the JVM (a system property holds
 * the rows), not in this module, so a reload of the module neither loses them nor installs a second set.
 */
public final class TickMeter {
    private static final String KEY = "blockwright.tickMeter";

    private TickMeter() {
    }

    /** Installs the listeners unless they are there; answers {@code {installed, ticks}} ({@code installed} false when they were). */
    public static Map<String, Object> start(Context ctx, Args args) {
        Levels.requireServer(ctx);
        List<long[]> kept = rows();
        if (kept != null) {
            return obj("installed", false, "ticks", kept.size());
        }
        List<long[]> rows = Collections.synchronizedList(new ArrayList<>());
        long[] at = new long[5];
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGHEST, false, ServerTickEvent.Pre.class, event -> {
            at[0] = System.nanoTime();
            at[4] = System.currentTimeMillis();
        });
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGHEST, false, ServerTickEvent.Post.class, event -> at[1] = System.nanoTime());
        NeoForge.EVENT_BUS.addListener(EventPriority.HIGH, false, ServerTickEvent.Post.class, event -> at[2] = System.nanoTime());
        NeoForge.EVENT_BUS.addListener(EventPriority.LOW, false, ServerTickEvent.Post.class, event -> at[3] = System.nanoTime());
        NeoForge.EVENT_BUS.addListener(EventPriority.LOWEST, false, ServerTickEvent.Post.class, event -> {
            MinecraftServer server = event.getServer();
            if (at[0] == 0L || !server.tickRateManager().runsNormally()) {
                return;
            }
            long now = System.nanoTime();
            rows.add(new long[] {server.overworld().getGameTime(), at[0], now - at[0], now - at[1], at[3] - at[2], at[4]});
        });
        System.getProperties().put(KEY, rows);
        return obj("installed", true, "ticks", 0);
    }

    /**
     * {@code {path}}: writes every row kept so far to a CSV file
     * ({@code game_time,wall_ns,full_ns,post_ns,normal_ns,epoch_ms}); answers {@code {path, ticks}}. The meter
     * keeps running.
     */
    public static Map<String, Object> dump(Context ctx, Args args) throws Exception {
        List<long[]> rows = started();
        Path path = Path.of(args.string("path"));
        if (path.getParent() != null) {
            Files.createDirectories(path.getParent());
        }
        int written = 0;
        try (BufferedWriter out = Files.newBufferedWriter(path)) {
            out.write("game_time,wall_ns,full_ns,post_ns,normal_ns,epoch_ms\n");
            synchronized (rows) {
                for (long[] row : rows) {
                    out.write(row[0] + "," + row[1] + "," + row[2] + "," + row[3] + "," + row[4] + "," + row[5] + "\n");
                    written++;
                }
            }
        }
        return obj("path", path.toString(), "ticks", written);
    }

    /** {@code {ticks, meanMs, p95Ms, maxMs}} over the full tick time of every row kept so far. */
    public static Map<String, Object> summary(Context ctx, Args args) {
        List<long[]> rows = started();
        long[] full;
        synchronized (rows) {
            full = rows.stream().mapToLong(row -> row[2]).sorted().toArray();
        }
        if (full.length == 0) {
            return obj("ticks", 0, "meanMs", 0.0, "p95Ms", 0.0, "maxMs", 0.0);
        }
        double total = 0;
        for (long nanos : full) {
            total += nanos;
        }
        long p95 = full[Math.min(full.length - 1, Math.max(0, (int) Math.ceil(full.length * 0.95) - 1))];
        return obj("ticks", full.length, "meanMs", total / full.length / 1e6, "p95Ms", p95 / 1e6,
            "maxMs", full[full.length - 1] / 1e6);
    }

    private static List<long[]> started() {
        List<long[]> rows = rows();
        if (rows == null) {
            throw Fail.unavailable("the tick meter is not running: start it first (tick.meter.start)");
        }
        return rows;
    }

    @SuppressWarnings("unchecked")
    private static List<long[]> rows() {
        return System.getProperties().get(KEY) instanceof List<?> kept ? (List<long[]>) kept : null;
    }
}
