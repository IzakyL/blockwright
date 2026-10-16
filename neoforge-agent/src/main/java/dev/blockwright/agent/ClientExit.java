package dev.blockwright.agent;

import net.minecraft.client.Minecraft;

import org.lwjgl.system.JNI;
import org.lwjgl.system.linux.DynamicLinkLoader;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.LockSupport;

/**
 * Lets an offscreen client end cleanly on SIGTERM (the driver's close). A JVM exit runs the C exit handlers, and the
 * NVIDIA EGL library's crash there (SIGSEGV in libEGL_nvidia.so, even with the context released), leaving a JVM
 * crash log and then hanging on the core dump until the driver's SIGKILL. So a shutdown hook has the render thread
 * release the offscreen context and stop there, flushes the logs, and ends the process with {@code _exit}: exit
 * status 143 (SIGTERM's), no C exit handlers. It waits briefly first so the other shutdown hooks can finish.
 * Client-only: it names {@link Minecraft}.
 */
final class ClientExit {
    /** How long the hook waits for the render thread to release the context (it may be busy or already gone). */
    private static final long RELEASE_WAIT_MILLIS = 3_000L;
    /** How long the other shutdown hooks get before {@code _exit}. */
    private static final long OTHER_HOOKS_MILLIS = 250L;
    private static final int SIGTERM_STATUS = 128 + 15;
    private static final AtomicBoolean INSTALLED = new AtomicBoolean(false);
    /** {@code _exit} from libc, resolved when installed so the hook loads nothing while the JVM shuts down. */
    private static long exitFunction;

    private ClientExit() {
    }

    /** Installs the hook once; called on the render thread when the offscreen context is made current. */
    static void install() {
        if (!ClientOffscreen.usesEgl()) {
            return;
        }
        if (!INSTALLED.compareAndSet(false, true)) {
            return;
        }
        try {
            long libc = DynamicLinkLoader.dlopen("libc.so.6", DynamicLinkLoader.RTLD_LAZY | DynamicLinkLoader.RTLD_NOLOAD);
            exitFunction = libc == 0L ? 0L : DynamicLinkLoader.dlsym(libc, "_exit");
        } catch (Throwable unavailable) {
            exitFunction = 0L;
        }
        Runtime.getRuntime().addShutdownHook(new Thread(ClientExit::onShutdown, "Blockwright offscreen exit"));
    }

    private static void onShutdown() {
        boolean released = releaseContext();
        if (!released || exitFunction == 0L) {
            // The render thread may still hold the context, or there is no _exit: leave the exit to the JVM.
            return;
        }
        try {
            Thread.sleep(OTHER_HOOKS_MILLIS);
        } catch (InterruptedException ignored) {
        }
        try {
            org.apache.logging.log4j.LogManager.shutdown();
        } catch (Throwable ignored) {
        }
        CoverageDump.dump();
        System.out.flush();
        System.err.flush();
        JNI.invokeV(SIGTERM_STATUS, exitFunction);
    }

    private static boolean releaseContext() {
        Minecraft minecraft;
        try {
            minecraft = Minecraft.getInstance();
        } catch (Throwable notYet) {
            return false;
        }
        if (minecraft == null) {
            return false;
        }
        CountDownLatch released = new CountDownLatch(1);
        try {
            minecraft.execute(() -> {
                try {
                    ClientOffscreen.release();
                } catch (Throwable ignored) {
                } finally {
                    released.countDown();
                }
                // The context is gone: this thread must not render again. The exit ends it.
                while (true) {
                    LockSupport.park();
                }
            });
            return released.await(RELEASE_WAIT_MILLIS, TimeUnit.MILLISECONDS);
        } catch (Throwable ignored) {
            return false;
        }
    }
}
