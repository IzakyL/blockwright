package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Sync;
import blockwright.minecraft.core.Values;
import blockwright.minecraft.core.Wait;

import dev.blockwright.api.Context;
import dev.blockwright.api.TaskException;

import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

import net.minecraft.server.MinecraftServer;
import net.minecraft.server.ServerTickRateManager;

/**
 * Waiting for a world condition while the world advances, decided in the game in one run.
 *
 * <p>Arguments ({@code args}): {@code advance} — {@code "sprint"} (default: run the world as fast as it
 * goes, frozen or not, and stop the sprint the tick the condition holds; a frozen server is frozen again) or
 * {@code "none"} (leave the tick rate alone: a running world advances at its rate, a frozen one only by what
 * others do); {@code maxTicks} — world ticks (overworld game time) to give up after, 0 = none;
 * {@code stepTicks} — check every this many world ticks (sprint) or server ticks (none), default 1;
 * {@code wait: {timeoutMs, progressEvery}} — as {@link Wait.Options}.
 *
 * <p>Answer: {@code {value, ticks, serverTicks, elapsedMs, gameTime}}, stamped when it sprinted. Out of
 * budget: {@code wait-timeout} with detail {@code {clock: "world", reason ("maxTicks"|"timeoutMs"), ticks,
 * serverTicks, elapsedMs, last}}. {@code ticks} are world ticks.
 */
public final class WorldWait {
    private WorldWait() {
    }

    /** Waits for {@code check} (answers as in {@link Wait}). Run on the server thread. */
    public static CompletableFuture<Object> until(Context ctx, Args args, Wait.Check check) {
        MinecraftServer server = Levels.requireServer(ctx);
        String advance = args.string("advance", "sprint");
        if (!advance.equals("sprint") && !advance.equals("none")) {
            throw Fail.invalid("args.advance must be sprint or none, got " + advance);
        }
        boolean sprint = advance.equals("sprint");
        long maxTicks = args.integer("maxTicks", 0, Integer.MAX_VALUE, 0);
        long stepTicks = args.integer("stepTicks", 1, Integer.MAX_VALUE, 1);
        Wait.Options given = Wait.Options.of(args.object("wait"));
        // World ticks: maxTicks (and progress) count game time, whether the world sprints, runs or stands still.
        Wait.Options options = new Wait.Options(given.timeoutMs(), maxTicks, given.progressEvery(), true);
        ServerTickRateManager manager = server.tickRateManager();

        long startGameTime = Wait.worldTime(server);
        long started = System.nanoTime();
        long[] serverTicks = {0};
        long[] nextCheck = {0};
        boolean[] ownSprint = {false};
        Object[] last = {null};
        Runnable stopSprint = () -> {
            if (ownSprint[0]) {
                ownSprint[0] = false;
                if (manager.isSprinting()) {
                    manager.stopSprinting();
                }
            }
        };
        ctx.onClose(() -> ctx.onServer(() -> {
            stopSprint.run();
            return null;
        }));

        boolean[] first = {true};
        CompletableFuture<Wait.Result> waited = Wait.until(ctx, Wait.Clock.WORLD_TICK, options, () -> {
            if (!first[0]) {
                serverTicks[0]++;
            }
            first[0] = false;
            long ticks = Wait.worldTime(server) - startGameTime;
            long clock = sprint ? ticks : serverTicks[0];
            boolean outOfTicks = maxTicks > 0 && ticks >= maxTicks;
            if (clock >= nextCheck[0] || outOfTicks) {
                nextCheck[0] = clock + stepTicks;
                Object answer = check.check();
                if (Wait.holds(answer)) {
                    stopSprint.run();
                    return answer;
                }
                last[0] = answer instanceof Wait.Pending pending ? pending.observed() : answer;
            }
            if (outOfTicks) {
                stopSprint.run();
            }
            return Wait.pending(last[0]);
        });
        if (sprint && !waited.isDone()) {
            manager.requestGameToSprint(maxTicks > 0 ? (int) maxTicks : Integer.MAX_VALUE);
            ownSprint[0] = true;
        }

        return waited.handle((result, failure) -> {
            long ticks = Wait.worldTime(server) - startGameTime;
            if (failure != null) {
                Throwable cause = Fail.unwrap(failure);
                TaskException timeout = cause instanceof TaskException task && Fail.WAIT_TIMEOUT.equals(task.code())
                    ? worldTimeout(task, maxTicks, ticks, serverTicks[0], started, last[0]) : null;
                throw timeout != null ? timeout : new CompletionException(cause);
            }
            Map<String, Object> answer = obj("value", result.value(),
                "ticks", ticks, "serverTicks", serverTicks[0], "elapsedMs", elapsedMs(started),
                "gameTime", Wait.worldTime(server));
            return sprint ? Sync.stamp(answer) : answer;
        });
    }

    /**
     * {@code {command, probe}}: waits until the command succeeds. A probe (a command built by the TS
     * {@code probeCommand}) that the game cannot evaluate ends the run {@code invalid} at once rather than
     * waiting out the budget; the value is {@code {command, output, resultCode}}.
     */
    public static CompletableFuture<Object> untilCommand(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        String command = args.string("command");
        boolean probe = args.flag("probe", false);
        return until(ctx, args, () -> {
            Commands.Result result = Commands.run(server, command);
            if (result.invoked() && result.success()) {
                return obj("command", result.command(), "output", result.output(), "resultCode", result.resultCode());
            }
            if (probe && Commands.verdict(result) == Commands.Verdict.UNEVALUABLE) {
                throw new TaskException(Fail.INVALID, "condition could not be evaluated: the game answered "
                    + Values.clip(String.join(" | ", result.output()), 300) + " (command: " + result.command()
                    + "). A misspelt NBT path, an unknown selector or item id, or an out-of-range coordinate; "
                    + "this is not the same as the condition being false.",
                    obj("command", result.command(), "output", result.output()));
            }
            return Wait.pending(result.output());
        });
    }

    /** The core wait's timeout in world terms: which budget ran out, world and server ticks, what it last saw. */
    private static TaskException worldTimeout(TaskException waitTimeout, long maxTicks, long ticks, long serverTicks,
                                              long started, Object last) {
        boolean outOfTicks = waitTimeout.detail() instanceof Map<?, ?> detail && "maxTicks".equals(detail.get("reason"));
        String why = outOfTicks
            ? "did not hold within " + maxTicks + " world ticks"
            : "did not hold within its wall-clock budget; a loaded host fits fewer ticks in the same time, so this is "
                + "not evidence the behaviour did not happen";
        return new TaskException(Fail.WAIT_TIMEOUT, "world condition " + why + " (" + ticks + " world ticks, "
            + serverTicks + " server ticks, last saw " + Values.clip(String.valueOf(last), 200) + ")",
            obj("clock", "world", "reason", outOfTicks ? "maxTicks" : "timeoutMs", "ticks", ticks,
                "serverTicks", serverTicks, "elapsedMs", elapsedMs(started), "last", last));
    }

    private static long elapsedMs(long started) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
    }
}
