package dev.blockwright.agent;

import java.lang.reflect.Method;

/**
 * Writes the JaCoCo agent's execution data now, when the driver launched the game with coverage on. The agent
 * writes it from its own shutdown hook, but the process can end without that hook finishing: {@link ClientExit}'s
 * {@code _exit} races it, and {@link OrphanGuard}'s halt skips every hook. The agent's classes are on the system
 * class path ({@code -javaagent}), which mod class loaders do not see, so it is reached through that loader.
 */
final class CoverageDump {
    private static final String RT = "org.jacoco.agent.rt.RT";
    private static final String AGENT = "org.jacoco.agent.rt.IAgent";

    private CoverageDump() {
    }

    /** Dumps without resetting; a later dump (the agent's own hook) appends, and appended sessions merge. */
    static void dump() {
        try {
            ClassLoader system = ClassLoader.getSystemClassLoader();
            Object agent = Class.forName(RT, true, system).getMethod("getAgent").invoke(null);
            Method dump = Class.forName(AGENT, true, system).getMethod("dump", boolean.class);
            dump.invoke(agent, false);
        } catch (ClassNotFoundException notMeasured) {
            // No JaCoCo agent: coverage is off.
        } catch (Throwable failed) {
            System.err.println("[blockwright] could not write coverage data: " + failed);
        }
    }
}
