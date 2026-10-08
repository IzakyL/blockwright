package dev.blockwright.agent;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.UndeclaredThrowableException;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

/** Turns a handler's failure into the text a caller sees: the real exception, not the hop that carried it. */
final class Failures {
    private static final int MAX_FRAMES = 8;
    private static final int MAX_CAUSES = 4;
    private static final String[] PLUMBING = {
        "dev.blockwright.agent.", "dev.blockwright.api.", "java.lang.reflect.", "java.lang.invoke.", "jdk.internal.", "java.util.concurrent.",
    };

    private Failures() {
    }

    /** The exception behind reflective, executor and future wrappers. */
    static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (isWrapper(current) && current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    private static boolean isWrapper(Throwable error) {
        return error instanceof InvocationTargetException
            || error instanceof ExecutionException
            || error instanceof CompletionException
            || error instanceof UndeclaredThrowableException;
    }

    /**
     * One line naming the exception, then the frames outside blockwright's own plumbing (snippet
     * frames carry their source line) and the cause chain. The agent's own argument errors are
     * already worded for the caller and come back as their message alone.
     */
    static String describe(Throwable error) {
        Throwable root = unwrap(error);
        if (isOwnMessage(root)) {
            return root.getMessage();
        }
        StringBuilder text = new StringBuilder(context(error)).append(headline(root));
        appendFrames(text, root);
        Map<Throwable, Boolean> seen = new IdentityHashMap<>();
        seen.put(root, true);
        int causes = 0;
        for (Throwable cause = root.getCause(); cause != null && !seen.containsKey(cause); cause = cause.getCause()) {
            if (++causes > MAX_CAUSES) {
                text.append("\n  … more causes");
                break;
            }
            seen.put(cause, true);
            text.append("\ncaused by ").append(headline(cause));
            appendFrames(text, cause);
        }
        return text.toString();
    }

    /** What the wrappers say about where the exception came from, such as the invoked method's signature. */
    private static String context(Throwable error) {
        StringBuilder text = new StringBuilder();
        for (Throwable current = error; isWrapper(current) && current.getCause() != null; current = current.getCause()) {
            if (current instanceof InvocationTargetException && current.getMessage() != null) {
                text.append(current.getMessage()).append(' ');
            }
        }
        return text.toString();
    }

    private static String headline(Throwable error) {
        String message = error.getMessage();
        return error.getClass().getName() + (message == null || message.isEmpty() ? "" : ": " + message);
    }

    private static boolean isOwnMessage(Throwable error) {
        if (!(error instanceof IllegalArgumentException || error instanceof IllegalStateException)
            || error.getMessage() == null || error.getCause() != null) {
            return false;
        }
        StackTraceElement[] frames = error.getStackTrace();
        return frames.length > 0 && frames[0].getClassName().startsWith("dev.blockwright.agent.");
    }

    private static void appendFrames(StringBuilder text, Throwable error) {
        List<String> kept = new ArrayList<>();
        int skipped = 0;
        for (StackTraceElement frame : error.getStackTrace()) {
            if (isPlumbing(frame.getClassName())) {
                continue;
            }
            if (kept.size() >= MAX_FRAMES) {
                skipped++;
                continue;
            }
            kept.add(frame(frame));
        }
        for (String frame : kept) {
            text.append("\n  at ").append(frame);
        }
        if (skipped > 0) {
            text.append("\n  … ").append(skipped).append(" more frames");
        }
    }

    private static boolean isPlumbing(String className) {
        for (String prefix : PLUMBING) {
            if (className.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    private static String frame(StackTraceElement frame) {
        if (isSnippet(frame.getClassName()) && frame.getLineNumber() > 0) {
            return frame.getClassName() + "." + frame.getMethodName() + " (task line " + frame.getLineNumber() + ")";
        }
        return frame.toString();
    }

    /** Task classes sit in the default package: {@code Task} and its nested or sibling classes. */
    private static boolean isSnippet(String className) {
        return className.indexOf('.') < 0;
    }
}
