package dev.blockwright.agent;

import java.util.OptionalLong;
import java.util.concurrent.atomic.AtomicBoolean;

final class OrphanGuard {
    private static final long POLL_INTERVAL_MILLIS = 5000L;
    private static final AtomicBoolean STARTED = new AtomicBoolean(false);
    private static final AtomicBoolean KILLED = new AtomicBoolean(false);

    private OrphanGuard() {
    }

    static void startWatchdog(String role) {
        OptionalLong parent = parentPid();
        if (parent.isEmpty()) {
            return;
        }
        if (!STARTED.compareAndSet(false, true)) {
            return;
        }
        long pid = parent.getAsLong();
        Thread thread = new Thread(() -> watch(pid, role), "Blockwright NeoForge orphan guard");
        thread.setDaemon(true);
        thread.start();
    }

    private static void watch(long parentPid, String role) {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                Thread.sleep(POLL_INTERVAL_MILLIS);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            if (!isAlive(parentPid)) {
                selfKill(role, parentPid);
                return;
            }
        }
    }

    private static void selfKill(String role, long parentPid) {
        if (!KILLED.compareAndSet(false, true)) {
            return;
        }
        AgentTrace.emit(
            "neoforge.agent.orphan-selfkill",
            role,
            Json.of("parentPid", parentPid, "trigger", "watchdog"));
        CoverageDump.dump();
        Runtime.getRuntime().halt(0);
    }

    private static boolean isAlive(long pid) {
        return ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
    }

    private static OptionalLong parentPid() {
        String raw = Endpoints.setting("blockwright.parentPid", "BLOCKWRIGHT_PARENT_PID", "");
        if (raw.isBlank()) {
            return OptionalLong.empty();
        }
        try {
            long pid = Long.parseLong(raw.trim());
            return pid > 0 ? OptionalLong.of(pid) : OptionalLong.empty();
        } catch (NumberFormatException error) {
            return OptionalLong.empty();
        }
    }
}
