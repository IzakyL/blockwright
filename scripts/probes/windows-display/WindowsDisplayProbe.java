import org.lwjgl.Version;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.glfw.GLFWErrorCallback;
import org.lwjgl.glfw.GLFWNativeWGL;
import org.lwjgl.glfw.GLFWNativeWin32;
import org.lwjgl.openal.AL;
import org.lwjgl.openal.AL10;
import org.lwjgl.openal.ALC;
import org.lwjgl.openal.ALC10;
import org.lwjgl.openal.ALCCapabilities;
import org.lwjgl.openal.SOFTLoopback;
import org.lwjgl.opengl.GL;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL30;
import org.lwjgl.system.JNI;
import org.lwjgl.system.Library;
import org.lwjgl.system.MemoryStack;
import org.lwjgl.system.SharedLibrary;

import java.nio.ByteBuffer;
import java.nio.IntBuffer;
import java.nio.ShortBuffer;
import java.util.concurrent.TimeUnit;

/** Independent graphics/audio validation. Does not bootstrap Minecraft or the agent. */
public final class WindowsDisplayProbe {
    public static void main(String[] args) throws Exception {
        check(System.getProperty("os.name").startsWith("Windows"), "Windows is required");
        int iterations = args.length > 0 ? Integer.parseInt(args[0]) : 5;
        int frames = args.length > 1 ? Integer.parseInt(args[1]) : 120;
        System.out.println("LWJGL=" + Version.getVersion() + "; GLFW=" + GLFW.glfwGetVersionString());
        try (SharedLibrary user32 = Library.loadNative(WindowsDisplayProbe.class, "probe", "user32")) {
            long isWindowVisible = user32.getFunctionAddress("IsWindowVisible");
            long getForegroundWindow = user32.getFunctionAddress("GetForegroundWindow");
            check(isWindowVisible != 0L && getForegroundWindow != 0L, "Win32 visibility/focus APIs");
            for (int iteration = 0; iteration < iterations; iteration++) {
                graphics(frames, isWindowVisible, getForegroundWindow);
                audio();
                System.out.println("PASS iteration=" + (iteration + 1) + " frames=" + frames
                    + " fbo=RGBA8 visible=false foreground=false audio=48000Hz/stereo/float32 released=true");
            }
        }
    }

    private static void graphics(int frames, long isWindowVisible, long getForegroundWindow) throws Exception {
        GLFWErrorCallback errors = GLFWErrorCallback.createPrint(System.err);
        GLFW.glfwSetErrorCallback(errors);
        long window = 0L;
        int framebuffer = 0;
        int texture = 0;
        try {
            GLFW.glfwInitHint(GLFW.GLFW_PLATFORM, GLFW.GLFW_PLATFORM_WIN32);
            check(GLFW.glfwInit(), "glfwInit");
            GLFW.glfwDefaultWindowHints();
            GLFW.glfwWindowHint(GLFW.GLFW_VISIBLE, GLFW.GLFW_FALSE);
            GLFW.glfwWindowHint(GLFW.GLFW_FOCUSED, GLFW.GLFW_FALSE);
            GLFW.glfwWindowHint(GLFW.GLFW_FOCUS_ON_SHOW, GLFW.GLFW_FALSE);
            GLFW.glfwWindowHint(GLFW.GLFW_CLIENT_API, GLFW.GLFW_OPENGL_API);
            GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_CREATION_API, GLFW.GLFW_NATIVE_CONTEXT_API);
            GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_VERSION_MAJOR, 3);
            GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_VERSION_MINOR, 2);
            GLFW.glfwWindowHint(GLFW.GLFW_OPENGL_PROFILE, GLFW.GLFW_OPENGL_CORE_PROFILE);
            window = GLFW.glfwCreateWindow(320, 240, "Blockwright hidden display probe", 0L, 0L);
            check(window != 0L, "hidden OpenGL 3.2 core window creation");
            long hwnd = GLFWNativeWin32.glfwGetWin32Window(window);
            check(hwnd != 0L && GLFWNativeWGL.glfwGetWGLContext(window) != 0L, "native HWND/WGL context");
            GLFW.glfwMakeContextCurrent(window);
            check(GL.createCapabilities().OpenGL32, "OpenGL 3.2 support");
            GLFW.glfwSwapInterval(0);
            System.out.println("GL vendor=" + GL11.glGetString(GL11.GL_VENDOR)
                + "; renderer=" + GL11.glGetString(GL11.GL_RENDERER)
                + "; version=" + GL11.glGetString(GL11.GL_VERSION));
            try (MemoryStack stack = MemoryStack.stackPush()) {
                IntBuffer width = stack.mallocInt(1);
                IntBuffer height = stack.mallocInt(1);
                GLFW.glfwGetFramebufferSize(window, width, height);
                check(width.get(0) > 0 && height.get(0) > 0, "nonzero hidden framebuffer dimensions");
                System.out.println("hidden framebuffer=" + width.get(0) + "x" + height.get(0));
                texture = GL11.glGenTextures();
                GL11.glBindTexture(GL11.GL_TEXTURE_2D, texture);
                GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA8, 32, 32, 0,
                    GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, (ByteBuffer) null);
                framebuffer = GL30.glGenFramebuffers();
                GL30.glBindFramebuffer(GL30.GL_FRAMEBUFFER, framebuffer);
                GL30.glFramebufferTexture2D(GL30.GL_FRAMEBUFFER, GL30.GL_COLOR_ATTACHMENT0,
                    GL11.GL_TEXTURE_2D, texture, 0);
                check(GL30.glCheckFramebufferStatus(GL30.GL_FRAMEBUFFER) == GL30.GL_FRAMEBUFFER_COMPLETE,
                    "RGBA8 framebuffer completeness");
                GL11.glViewport(0, 0, 32, 32);
                ByteBuffer pixel = stack.malloc(4);
                for (int frame = 0; frame < frames; frame++) {
                    GLFW.glfwPollEvents();
                    check(GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_VISIBLE) == GLFW.GLFW_FALSE,
                        "GLFW window stayed hidden");
                    check(JNI.callPI(hwnd, isWindowVisible) == 0, "native window stayed hidden");
                    check(JNI.callP(getForegroundWindow) != hwnd, "native window did not steal focus");
                    int red = (frame & 1) == 0 ? 64 : 192;
                    GL11.glClearColor(red / 255f, 128f / 255, 191f / 255, 1f);
                    GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
                    GL11.glReadPixels(16, 16, 1, 1, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixel);
                    check(Math.abs(Byte.toUnsignedInt(pixel.get(0)) - red) <= 1
                        && Math.abs(Byte.toUnsignedInt(pixel.get(1)) - 128) <= 1
                        && Math.abs(Byte.toUnsignedInt(pixel.get(2)) - 191) <= 1
                        && Byte.toUnsignedInt(pixel.get(3)) == 255, "expected changing framebuffer pixels");
                    GLFW.glfwSwapBuffers(window);
                    TimeUnit.MILLISECONDS.sleep(5);
                }
                check(GL11.glGetError() == GL11.GL_NO_ERROR, "no OpenGL errors");
            }
        } finally {
            if (framebuffer != 0) GL30.glDeleteFramebuffers(framebuffer);
            if (texture != 0) GL11.glDeleteTextures(texture);
            if (window != 0L) {
                GLFW.glfwMakeContextCurrent(0L);
                GL.setCapabilities(null);
                GLFW.glfwDestroyWindow(window);
            }
            GLFW.glfwTerminate();
            GLFW.glfwSetErrorCallback(null);
            errors.free();
        }
    }

    private static void audio() {
        long device = SOFTLoopback.alcLoopbackOpenDeviceSOFT((CharSequence) null);
        check(device != 0L, "OpenAL loopback device");
        long context = 0L;
        int buffer = 0;
        int source = 0;
        try (MemoryStack stack = MemoryStack.stackPush()) {
            ALCCapabilities capabilities = ALC.createCapabilities(device);
            check(capabilities.ALC_SOFT_loopback, "ALC_SOFT_loopback extension");
            check(SOFTLoopback.alcIsRenderFormatSupportedSOFT(device, 48_000,
                SOFTLoopback.ALC_STEREO_SOFT, SOFTLoopback.ALC_FLOAT_SOFT), "48kHz stereo float32 format");
            context = ALC10.alcCreateContext(device, stack.ints(
                SOFTLoopback.ALC_FORMAT_CHANNELS_SOFT, SOFTLoopback.ALC_STEREO_SOFT,
                SOFTLoopback.ALC_FORMAT_TYPE_SOFT, SOFTLoopback.ALC_FLOAT_SOFT,
                ALC10.ALC_FREQUENCY, 48_000, 0));
            check(context != 0L && ALC10.alcMakeContextCurrent(context), "OpenAL loopback context");
            AL.createCapabilities(capabilities);
            ShortBuffer tone = stack.mallocShort(4800);
            for (int i = 0; i < tone.capacity(); i++) {
                tone.put(i, (short) (Math.sin(i * 2 * Math.PI * 440 / 48_000) * 16_000));
            }
            buffer = AL10.alGenBuffers();
            AL10.alBufferData(buffer, AL10.AL_FORMAT_MONO16, tone, 48_000);
            source = AL10.alGenSources();
            AL10.alSourcei(source, AL10.AL_BUFFER, buffer);
            AL10.alSourcePlay(source);
            float[] samples = new float[4800 * 2];
            SOFTLoopback.alcRenderSamplesSOFT(device, samples, 4800);
            double squares = 0;
            for (float sample : samples) {
                check(Float.isFinite(sample), "finite audio samples");
                squares += sample * sample;
            }
            double rms = Math.sqrt(squares / samples.length);
            check(rms > 0.01, "non-silent synthesized loopback tone");
            check(AL10.alGetError() == AL10.AL_NO_ERROR, "no OpenAL errors");
            System.out.println("OpenAL vendor=" + AL10.alGetString(AL10.AL_VENDOR)
                + "; renderer=" + AL10.alGetString(AL10.AL_RENDERER)
                + "; version=" + AL10.alGetString(AL10.AL_VERSION) + "; rms=" + rms);
        } finally {
            if (source != 0) AL10.alDeleteSources(source);
            if (buffer != 0) AL10.alDeleteBuffers(buffer);
            if (context != 0L) {
                ALC10.alcMakeContextCurrent(0L);
                ALC10.alcDestroyContext(context);
            }
            check(ALC10.alcCloseDevice(device), "close loopback device");
        }
    }

    private static void check(boolean success, String message) {
        if (!success) throw new IllegalStateException("Probe failed: " + message);
    }
}
