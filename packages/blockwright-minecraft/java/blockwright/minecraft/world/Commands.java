package blockwright.minecraft.world;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Sync;

import dev.blockwright.api.Context;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.rcon.RconConsoleSource;

/**
 * Server commands run as the console (permission level 4, at the world spawn), with their chat output
 * captured. Call on the server thread.
 *
 * <p>A {@link Result} says whether the command was {@code invoked} (the game reported a result for it) and
 * whether it {@code succeeded}. A probe ({@code execute <condition> run time query gametime}) turns that into a
 * three-way {@link Verdict}: {@code TRUE} (the run clause ran), {@code FALSE} (it did not, and nothing was said)
 * or {@code UNEVALUABLE} (the game said something instead: a parse error, an unknown selector...).
 */
public final class Commands {
    private Commands() {
    }

    public record Result(String command, boolean invoked, boolean success, int resultCode, List<String> output) {
        public Map<String, Object> json() {
            Map<String, Object> json = obj("command", command, "invoked", invoked, "success", invoked && success,
                "resultCode", resultCode, "output", output);
            return json;
        }
    }

    public enum Verdict {
        TRUE, FALSE, UNEVALUABLE;

        public String wire() {
            return switch (this) {
                case TRUE -> "true";
                case FALSE -> "false";
                case UNEVALUABLE -> "unevaluable";
            };
        }
    }

    /** {@code command} with a leading slash or surrounding blanks removed. */
    public static String normalize(String command) {
        String text = command == null ? "" : command.trim();
        return text.startsWith("/") ? text.substring(1).trim() : text;
    }

    /** Runs {@code command} as the console and captures what it said. Server thread. */
    public static Result run(MinecraftServer server, String command) {
        String text = normalize(command);
        if (text.isEmpty()) {
            throw Fail.invalid("command must not be empty");
        }
        boolean[] invoked = {false};
        boolean[] success = {false};
        int[] code = {0};
        RconConsoleSource console = new RconConsoleSource(server);
        console.prepareForCommand();
        CommandSourceStack source = console.createCommandSourceStack().withCallback((ok, value) -> {
            invoked[0] = true;
            success[0] = ok;
            code[0] = value;
        });
        server.getCommands().performPrefixedCommand(source, text);
        List<String> output = new ArrayList<>();
        for (String line : console.getCommandResponse().split("\n")) {
            if (!line.isEmpty()) {
                output.add(line);
            }
        }
        return new Result(text, invoked[0], success[0], code[0], output);
    }

    /** What a probe command's result means. */
    public static Verdict verdict(Result result) {
        if (result.invoked() && result.success()) {
            return Verdict.TRUE;
        }
        return result.output().isEmpty() ? Verdict.FALSE : Verdict.UNEVALUABLE;
    }

    // Task entry points.

    /**
     * {@code {commands: [...]}}: runs them in order and answers their results, stamped: a command may change
     * anything. With {@code stopOnFailure}, it stops at the first command that did not succeed.
     */
    public static Object execute(Context ctx, Args args) {
        MinecraftServer server = Levels.requireServer(ctx);
        List<String> commands = args.strings("commands");
        if (commands == null || commands.isEmpty()) {
            throw Fail.invalid("args.commands must not be empty");
        }
        boolean stopOnFailure = args.flag("stopOnFailure", false);
        List<Object> results = new ArrayList<>();
        for (String command : commands) {
            Result result = run(server, command);
            results.add(result.json());
            if (stopOnFailure && !(result.invoked() && result.success())) {
                break;
            }
        }
        return Sync.stamp(results);
    }

    /**
     * {@code {command}}: an already built probe command (see the TS {@code probeCommand}); answers
     * {@code {verdict, command, success, resultCode, output}}. Reads only, so it does not stamp.
     */
    public static Object probe(Context ctx, Args args) {
        Result result = run(Levels.requireServer(ctx), args.string("command"));
        Map<String, Object> json = result.json();
        json.put("verdict", verdict(result).wire());
        return json;
    }
}
