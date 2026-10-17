package dev.blockwright.agent;

import dev.blockwright.api.AudioBlock;
import dev.blockwright.api.Hooks;
import dev.blockwright.api.Registration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.openal.AL;
import org.lwjgl.openal.AL10;
import org.lwjgl.openal.ALC;
import org.lwjgl.openal.ALC10;
import org.lwjgl.openal.ALCCapabilities;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import org.lwjgl.system.MemoryStack;

import java.nio.ByteBuffer;
import java.nio.ShortBuffer;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ClientOffscreenTest {
    @Test
    void windowsDevicePolicyRejectsUnsupportedRequests() {
        assertDoesNotThrow(() -> ClientOffscreen.validateWindowsDevice("auto"));
        assertDoesNotThrow(() -> ClientOffscreen.validateWindowsDevice("gpu"));
        for (String device : new String[] {"software", "index:0", "index:-1", "invalid"}) {
            IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> ClientOffscreen.validateWindowsDevice(device));
            assertTrue(failure.getMessage().contains("device=" + device));
        }
    }

    /** Explicit opt-in because this exercises the real desktop GPU, not a mocked GL context. */
    @Test
    @EnabledIfSystemProperty(named = "blockwright.test.windowsDisplay", matches = "true")
    void productionBackendRendersHiddenFramebufferAndReleasesContext() throws Exception {
        assertTrue(System.getProperty("os.name").startsWith("Windows"));
        String previousEnabled = System.getProperty("blockwright.enabled");
        String previousDevice = System.getProperty("blockwright.display.device");
        System.setProperty("blockwright.enabled", "true");
        System.setProperty("blockwright.display.device", "gpu");
        long window = 0L;
        int texture = 0;
        int framebuffer = 0;
        try {
            assertTrue(ClientOffscreen.enabled());
            assertTrue(ClientOffscreen.usesHiddenWindow());
            assertTrue(!ClientOffscreen.usesEgl());
            ClientOffscreen.applyInitHints();
            assertTrue(GLFW.glfwInit());
            GLFW.glfwDefaultWindowHints();
            ClientOffscreen.applyWindowHints();
            GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_VERSION_MAJOR, 3);
            GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_VERSION_MINOR, 2);
            GLFW.glfwWindowHint(GLFW.GLFW_OPENGL_PROFILE, GLFW.GLFW_OPENGL_CORE_PROFILE);
            window = GLFW.glfwCreateWindow(320, 240, "Blockwright backend test", 0L, 0L);
            assertTrue(window != 0L);
            ClientOffscreen.makeContextCurrent(window);
            ClientOffscreen.deliverWindowFocus(window);
            GLFW.glfwPollEvents();
            assertEquals(GLFW.GLFW_FALSE, GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_VISIBLE));
            assertEquals(GLFW.GLFW_FALSE, GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_FOCUSED));
            texture = GL11.glGenTextures();
            GL11.glBindTexture(GL11.GL_TEXTURE_2D, texture);
            GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA8, 16, 16, 0,
                GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, (ByteBuffer) null);
            framebuffer = GL30.glGenFramebuffers();
            GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, framebuffer);
            GL30.glFramebufferTexture2D(GL30.GL_FRAMEBUFFER, GL30.GL_COLOR_ATTACHMENT0,
                GL11.GL_TEXTURE_2D, texture, 0);
            assertEquals(GL30.GL_FRAMEBUFFER_COMPLETE, GL30.glCheckFramebufferStatus(GL30.GL_FRAMEBUFFER));
            GL11.glViewport(0, 0, 16, 16);
            GL11.glClearColor(1f, 0f, 0f, 1f);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
            try (MemoryStack stack = MemoryStack.stackPush()) {
                ByteBuffer pixel = stack.malloc(4);
                GL11.glReadPixels(8, 8, 1, 1, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixel);
                assertEquals(255, Byte.toUnsignedInt(pixel.get(0)));
                assertEquals(0, Byte.toUnsignedInt(pixel.get(1)));
                assertEquals(0, Byte.toUnsignedInt(pixel.get(2)));
            }
            GL30.glDeleteFramebuffers(framebuffer);
            framebuffer = 0;
            GL11.glDeleteTextures(texture);
            texture = 0;
            ClientOffscreen.releaseWindowContext(window);
            assertEquals(0L, GLFW.glfwGetCurrentContext());
            // Audio is a managed-client capability even though the EGL backend is disabled.
            assertTrue(!ClientOffscreen.usesEgl());
            verifyProductionLoopbackAudio();
        } finally {
            if (framebuffer != 0) GL30.glDeleteFramebuffers(framebuffer);
            if (texture != 0) GL11.glDeleteTextures(texture);
            if (window != 0L) {
                ClientOffscreen.releaseWindowContext(window);
                GLFW.glfwDestroyWindow(window);
            }
            GLFW.glfwTerminate();
            restore("blockwright.enabled", previousEnabled);
            restore("blockwright.display.device", previousDevice);
        }
    }

    private static void verifyProductionLoopbackAudio() throws Exception {
        long device = ClientAudio.openDevice();
        long context = 0L;
        int buffer = 0;
        int source = 0;
        CountDownLatch mixed = new CountDownLatch(1);
        AtomicReference<AudioBlock> captured = new AtomicReference<>();
        try (MemoryStack stack = MemoryStack.stackPush();
             Registration subscription = Hooks.AUDIO_MIXED.subscribe(block -> {
                 for (float sample : block.samples()) {
                     if (Math.abs(sample) > 0.01f) {
                         captured.compareAndSet(null, block);
                         mixed.countDown();
                         break;
                     }
                 }
             })) {
            ALCCapabilities capabilities = ALC.createCapabilities(device);
            context = ClientAudio.createContext(device, null);
            assertTrue(context != 0L && ALC10.alcMakeContextCurrent(context));
            AL.createCapabilities(capabilities);
            ShortBuffer tone = stack.mallocShort(4800);
            for (int i = 0; i < tone.capacity(); i++) {
                tone.put(i, (short) (Math.sin(i * 2 * Math.PI * 440 / 48_000) * 16_000));
            }
            buffer = AL10.alGenBuffers();
            AL10.alBufferData(buffer, AL10.AL_FORMAT_MONO16, tone, 48_000);
            source = AL10.alGenSources();
            AL10.alSourcei(source, AL10.AL_BUFFER, buffer);
            AL10.alSourcei(source, AL10.AL_LOOPING, AL10.AL_TRUE);
            AL10.alSourcePlay(source);
            assertTrue(mixed.await(5, TimeUnit.SECONDS), "production audio thread must publish the synthesized tone");
            AudioBlock block = captured.get();
            assertEquals(48_000, block.sampleRate());
            assertEquals(2, block.channels());
            assertEquals(block.frames() * block.channels(), block.samples().length);
            for (float sample : block.samples()) assertTrue(Float.isFinite(sample));
            assertEquals(AL10.AL_NO_ERROR, AL10.alGetError());
        } finally {
            if (source != 0) AL10.alDeleteSources(source);
            if (buffer != 0) AL10.alDeleteBuffers(buffer);
            if (context != 0L) {
                ALC10.alcMakeContextCurrent(0L);
                ALC10.alcDestroyContext(context);
            }
            assertTrue(ClientAudio.closeDevice(device));
        }
    }

    private static void restore(String name, String value) {
        if (value == null) System.clearProperty(name);
        else System.setProperty(name, value);
    }
}
