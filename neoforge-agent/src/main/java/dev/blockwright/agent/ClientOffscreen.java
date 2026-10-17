package dev.blockwright.agent;

import java.util.Objects;

import org.lwjgl.PointerBuffer;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.opengl.GL;
import org.lwjgl.opengl.GL11;
import org.lwjgl.system.JNI;
import org.lwjgl.system.Library;
import org.lwjgl.system.MemoryStack;
import org.lwjgl.system.MemoryUtil;
import org.lwjgl.system.SharedLibrary;

import java.nio.IntBuffer;
import java.util.Locale;

public final class ClientOffscreen {
    private static final String DEVICE_PROPERTY = "blockwright.display.device";

    private static final int EGL_PLATFORM_DEVICE_EXT = 0x313F;
    private static final int EGL_DRM_RENDER_NODE_FILE_EXT = 0x3377;
    private static final int EGL_VENDOR = 0x3053;
    private static final int EGL_NONE = 0x3038;
    private static final int EGL_OPENGL_API = 0x30A2;
    private static final int EGL_SURFACE_TYPE = 0x3033;
    private static final int EGL_PBUFFER_BIT = 0x0001;
    private static final int EGL_RENDERABLE_TYPE = 0x3040;
    private static final int EGL_OPENGL_BIT = 0x0008;
    private static final int EGL_RED_SIZE = 0x3024;
    private static final int EGL_GREEN_SIZE = 0x3023;
    private static final int EGL_BLUE_SIZE = 0x3022;
    private static final int EGL_ALPHA_SIZE = 0x3021;
    private static final int EGL_DEPTH_SIZE = 0x3025;
    private static final int EGL_STENCIL_SIZE = 0x3026;
    private static final int EGL_WIDTH = 0x3057;
    private static final int EGL_HEIGHT = 0x3056;
    private static final int EGL_CONTEXT_MAJOR_VERSION = 0x3098;
    private static final int EGL_CONTEXT_MINOR_VERSION = 0x30FB;
    private static final int EGL_CONTEXT_OPENGL_PROFILE_MASK = 0x30FD;
    private static final int EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT = 0x0001;
    private static final int GL_MAJOR = 3;
    private static final int GL_MINOR = 2;
    private static final int GL_RENDERER = 0x1F01;
    private static final int GL_VERSION = 0x1F02;

    private static Egl egl;
    private static Chosen chosen;
    private static long hiddenWindow;

    private ClientOffscreen() {
    }

    private enum DeviceRequest {
        AUTO,
        GPU,
        SOFTWARE,
        INDEX
    }

    /**
     * Managed clients use an offscreen display and loopback sound. Windows keeps a hidden native
     * window for its WGL context; Linux uses EGL without a native window. This predicate describes
     * management, not the graphics backend, so input, audio and capture work on both platforms.
     */
    public static boolean enabled() {
        return AgentTrace.isEnabled();
    }

    public static boolean usesEgl() {
        return enabled() && !windows();
    }

    public static boolean usesHiddenWindow() {
        return enabled() && windows();
    }

    private static boolean windows() {
        return System.getProperty("os.name", "").startsWith("Windows");
    }

    public static void applyInitHints() {
        if (windows()) {
            validateWindowsDevice(deviceProperty());
            GLFW.glfwInitHint(GLFW.GLFW_PLATFORM, GLFW.GLFW_PLATFORM_WIN32);
        } else {
            GLFW.glfwInitHint(GLFW.GLFW_PLATFORM, GLFW.GLFW_PLATFORM_NULL);
        }
    }

    /** Applied after Minecraft resets GLFW hints and before NeoForge creates the native window. */
    public static void applyWindowHints() {
        if (!usesHiddenWindow()) {
            return;
        }
        GLFW.glfwWindowHint(GLFW.GLFW_VISIBLE, GLFW.GLFW_FALSE);
        GLFW.glfwWindowHint(GLFW.GLFW_FOCUSED, GLFW.GLFW_FALSE);
        GLFW.glfwWindowHint(GLFW.GLFW_FOCUS_ON_SHOW, GLFW.GLFW_FALSE);
        GLFW.glfwWindowHint(GLFW.GLFW_CLIENT_API, GLFW.GLFW_OPENGL_API);
        GLFW.glfwWindowHint(GLFW.GLFW_CONTEXT_CREATION_API, GLFW.GLFW_NATIVE_CONTEXT_API);
    }

    public static void makeContextCurrent(long window) {
        if (windows()) {
            makeHiddenContextCurrent(window);
            return;
        }
        if (chosen != null) {
            return;
        }
        egl = Egl.load();
        DeviceRequest request = request();
        int index = requestedIndex();
        chosen = select(request, index);
        ClientExit.install();

        boolean degraded = request == DeviceRequest.AUTO && chosen.software;
        AgentTrace.emit(
            "client.offscreen.context",
            AgentTrace.configuredRole("client"),
            Json.of(
                "backend", "egl",
                "platform", "linux",
                "device", Objects.toString(chosen.renderer, ""),
                "vendor", Objects.toString(chosen.vendor, ""),
                "gl", Objects.toString(chosen.version, ""),
                "index", chosen.index,
                "requested", Objects.toString(deviceProperty(), ""),
                "software", chosen.software,
                "degraded", degraded));
        if (degraded) {
            System.err.println(
                "[blockwright] [client.display] device=auto found no usable hardware EGL device "
                    + "and fell back to software rendering (" + chosen.renderer + "). "
                    + "Expect it to be one to two orders of magnitude slower. "
                    + "Use device=\"gpu\" to make this a hard failure instead.");
        }
    }

    static void validateWindowsDevice(String device) {
        if (!device.equals("auto") && !device.equals("gpu")) {
            throw new IllegalStateException(
                "Windows [client.display] supports device=auto or gpu using the system-selected GPU; "
                    + "device=" + device + " is not supported");
        }
    }

    private static void makeHiddenContextCurrent(long window) {
        validateWindowsDevice(deviceProperty());
        if (window == 0L) {
            throw new IllegalStateException("Windows offscreen display has no native GLFW window");
        }
        if (GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_VISIBLE) != GLFW.GLFW_FALSE) {
            throw new IllegalStateException(
                "Windows offscreen display must be created hidden; disable the NeoForge early window");
        }
        GLFW.glfwMakeContextCurrent(window);
        if (hiddenWindow == window) {
            return;
        }
        if (!GL.createCapabilities().OpenGL32) {
            throw new IllegalStateException("Windows offscreen display requires an OpenGL 3.2 core GPU context");
        }
        String renderer = GL11.glGetString(GL_RENDERER);
        if (renderer != null && Egl.isSoftware(renderer)) {
            throw new IllegalStateException(
                "Windows offscreen display requires a GPU driver; software renderer " + renderer + " is not supported");
        }
        hiddenWindow = window;
        AgentTrace.emit(
            "client.offscreen.context",
            AgentTrace.configuredRole("client"),
            Json.of(
                "backend", "wgl",
                "platform", "win32",
                "device", Objects.toString(renderer, ""),
                "vendor", Objects.toString(GL11.glGetString(GL11.GL_VENDOR), ""),
                "gl", Objects.toString(GL11.glGetString(GL_VERSION), ""),
                "index", -1,
                "requested", deviceProperty(),
                "software", false,
                "degraded", false));
    }

    /** Called on the render thread immediately before Minecraft destroys its native window. */
    public static void releaseWindowContext(long window) {
        if (usesHiddenWindow() && hiddenWindow == window) {
            release();
        }
    }

    /**
     * Unbinds and destroys the offscreen context before the process ends. Must run on the thread it
     * is current on: exiting with it live lets the NVIDIA EGL library tear it down from its exit
     * handlers, which can crash the JVM on its way out.
     */
    static void release() {
        if (windows()) {
            if (hiddenWindow != 0L) {
                GLFW.glfwMakeContextCurrent(0L);
                GL.setCapabilities(null);
                hiddenWindow = 0L;
            }
            // Minecraft's Window.close owns destruction of the native WGL context and window.
            return;
        }
        if (chosen == null) {
            return;
        }
        egl.release(chosen);
        chosen = null;
    }

    public static void deliverWindowFocus(long window) {
        if (windows()) {
            // Gameplay focus is supplied by WindowMixin; never show or focus the native window.
            return;
        }
        if (GLFW.glfwGetWindowAttrib(window, GLFW.GLFW_FOCUSED) != GLFW.GLFW_TRUE) {
            return;
        }
        GLFW.glfwHideWindow(window);
        GLFW.glfwShowWindow(window);
        GLFW.glfwFocusWindow(window);
    }

    private static DeviceRequest request() {
        String value = deviceProperty();
        if (value.startsWith("index:")) {
            return DeviceRequest.INDEX;
        }
        return switch (value) {
            case "gpu" -> DeviceRequest.GPU;
            case "software" -> DeviceRequest.SOFTWARE;
            default -> DeviceRequest.AUTO;
        };
    }

    private static int requestedIndex() {
        String value = deviceProperty();
        if (!value.startsWith("index:")) {
            return -1;
        }
        try {
            return Integer.parseInt(value.substring("index:".length()).trim());
        } catch (NumberFormatException error) {
            throw new IllegalStateException(DEVICE_PROPERTY + "=" + value + " has no integer index");
        }
    }

    private static int surfaceWidth() {
        return positiveProperty("blockwright.display.width", 1280);
    }

    private static int surfaceHeight() {
        return positiveProperty("blockwright.display.height", 720);
    }

    private static int positiveProperty(String name, int fallback) {
        try {
            int value = Integer.parseInt(System.getProperty(name, ""));
            return value > 0 ? value : fallback;
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private static String deviceProperty() {
        String value = System.getProperty(DEVICE_PROPERTY, "auto");
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private static Chosen select(DeviceRequest request, int requestedIndex) {
        long[] devices = egl.queryDevices();
        StringBuilder rejected = new StringBuilder();
        int softwareFallbackIndex = -1;

        for (int index = 0; index < devices.length; index++) {
            if (request == DeviceRequest.INDEX && index != requestedIndex) {
                continue;
            }
            Chosen candidate = egl.open(devices[index], index);
            if (candidate == null) {
                rejected.append(rejected.length() == 0 ? "" : ", ")
                    .append(index).append("=")
                    .append(egl.lastFailure(devices[index]));
                continue;
            }
            boolean accepted = switch (request) {
                case GPU -> !candidate.software;
                case SOFTWARE -> candidate.software;
                case INDEX -> true;
                case AUTO -> !candidate.software;
            };
            if (accepted) {
                return candidate;
            }
            if (request == DeviceRequest.AUTO && candidate.software && softwareFallbackIndex < 0) {
                softwareFallbackIndex = index;
            }
            rejected.append(rejected.length() == 0 ? "" : ", ")
                .append(index).append("=").append(candidate.renderer);
            egl.release(candidate);
        }

        if (softwareFallbackIndex >= 0) {
            Chosen fallback = egl.open(devices[softwareFallbackIndex], softwareFallbackIndex);
            if (fallback != null) {
                return fallback;
            }
        }
        throw new IllegalStateException(
            "no EGL device provides an OpenGL " + GL_MAJOR + "." + GL_MINOR
                + " core context for [client.display] device=" + deviceProperty()
                + " (devices seen: " + devices.length
                + (rejected.length() == 0 ? "" : "; rejected: " + rejected) + ").\n"
                + "Blockwright is only supported on the NVIDIA proprietary driver, whose EGL "
                + "device lives on /dev/nvidia* (mode 0666, so any user can open it).\n"
                + "If the rejections above name /dev/dri/renderD* with eglInitialize 0x3001, "
                + "this is a Mesa (AMD/Intel) card and the process is not allowed to open its "
                + "render node -- those are root:render 0660 and desktop users are not in that "
                + "group by default. Untested path, but the fix is:\n"
                + "    sudo usermod -aG render \"$USER\"   # log back in for it to take effect\n"
                + "In a container, pass /dev/dri through and match the host render gid.");
    }

    private static final class Chosen {
        private final long display;
        private final long surface;
        private final long context;
        private final int index;
        private final String vendor;
        private final String renderer;
        private final String version;
        private final boolean software;

        private Chosen(long display, long surface, long context, int index, String vendor,
            String renderer, String version, boolean software) {
            this.display = display;
            this.surface = surface;
            this.context = context;
            this.index = index;
            this.vendor = vendor;
            this.renderer = renderer;
            this.version = version;
            this.software = software;
        }
    }

    private static final class Egl {
        private final long getProcAddress;
        private final long getError;
        private final long initialize;
        private final long terminate;
        private final long bindApi;
        private final long chooseConfig;
        private final long createPbufferSurface;
        private final long destroySurface;
        private final long createContext;
        private final long destroyContext;
        private final long makeCurrent;
        private final long queryString;
        private final long queryDevices;
        private final long queryDeviceString;
        private final long getPlatformDisplay;
        private String lastFailure = "";

        private Egl(SharedLibrary library) {
            getProcAddress = address(library, "eglGetProcAddress");
            getError = address(library, "eglGetError");
            initialize = address(library, "eglInitialize");
            terminate = address(library, "eglTerminate");
            bindApi = address(library, "eglBindAPI");
            chooseConfig = address(library, "eglChooseConfig");
            createPbufferSurface = address(library, "eglCreatePbufferSurface");
            destroySurface = address(library, "eglDestroySurface");
            createContext = address(library, "eglCreateContext");
            destroyContext = address(library, "eglDestroyContext");
            makeCurrent = address(library, "eglMakeCurrent");
            queryString = address(library, "eglQueryString");
            queryDevices = proc("eglQueryDevicesEXT");
            queryDeviceString = proc("eglQueryDeviceStringEXT");
            getPlatformDisplay = proc("eglGetPlatformDisplayEXT");
            if (queryDevices == 0L || getPlatformDisplay == 0L) {
                throw new IllegalStateException(
                    "libEGL has no EGL_EXT_platform_device / EGL_EXT_device_enumeration, so an "
                        + "offscreen client cannot pick a render device");
            }
        }

        private static Egl load() {
            // The runtime package ships only the versioned soname; the bare libEGL.so that "EGL"
            // maps to comes from the -dev package, so it is just the fallback.
            UnsatisfiedLinkError failure = null;
            for (String name : new String[] {"libEGL.so.1", "EGL"}) {
                try {
                    return new Egl(Library.loadNative(ClientOffscreen.class, "blockwright", name));
                } catch (UnsatisfiedLinkError error) {
                    if (failure == null) {
                        failure = error;
                    } else {
                        failure.addSuppressed(error);
                    }
                }
            }
            throw new IllegalStateException(
                "neither libEGL.so.1 nor libEGL.so is loadable, so an offscreen client has no way to "
                    + "create a GL context. Install the EGL runtime (Debian/Ubuntu: libegl1).", failure);
        }

        private static long address(SharedLibrary library, String name) {
            long address = library.getFunctionAddress(name);
            if (address == 0L) {
                throw new IllegalStateException("libEGL is missing " + name);
            }
            return address;
        }

        private long proc(String name) {
            try (MemoryStack stack = MemoryStack.stackPush()) {
                return JNI.callPP(MemoryUtil.memAddress(stack.UTF8(name)), getProcAddress);
            }
        }

        private long[] queryDevices() {
            try (MemoryStack stack = MemoryStack.stackPush()) {
                IntBuffer count = stack.mallocInt(1);
                if (JNI.callPPI(0, 0L, MemoryUtil.memAddress(count), queryDevices) == 0) {
                    throw new IllegalStateException(
                        "eglQueryDevicesEXT failed with 0x" + Integer.toHexString(error()));
                }
                int total = count.get(0);
                if (total <= 0) {
                    throw new IllegalStateException("EGL reports no render devices at all");
                }
                PointerBuffer handles = stack.mallocPointer(total);
                JNI.callPPI(total, MemoryUtil.memAddress(handles), MemoryUtil.memAddress(count),
                    queryDevices);
                long[] devices = new long[count.get(0)];
                for (int index = 0; index < devices.length; index++) {
                    devices[index] = handles.get(index);
                }
                return devices;
            }
        }

        private int error() {
            return JNI.callI(getError);
        }

        private String lastFailure(long device) {
            String node = string(JNI.callPP(device, EGL_DRM_RENDER_NODE_FILE_EXT, queryDeviceString));
            return (node == null ? lastFailure : node + " " + lastFailure);
        }

        private Chosen open(long device, int index) {
            long display = JNI.callPPP(EGL_PLATFORM_DEVICE_EXT, device, 0L, getPlatformDisplay);
            if (display == 0L) {
                lastFailure = "no display (0x" + Integer.toHexString(error()) + ")";
                return null;
            }
            long context;
            long surface;
            try (MemoryStack stack = MemoryStack.stackPush()) {
                IntBuffer major = stack.mallocInt(1);
                IntBuffer minor = stack.mallocInt(1);
                if (JNI.callPPPI(display, MemoryUtil.memAddress(major), MemoryUtil.memAddress(minor),
                    initialize) == 0) {
                    lastFailure = "eglInitialize 0x" + Integer.toHexString(error());
                    return null;
                }
                JNI.callI(EGL_OPENGL_API, bindApi);

                IntBuffer configAttributes = stack.ints(
                    EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
                    EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
                    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
                    EGL_DEPTH_SIZE, 24, EGL_STENCIL_SIZE, 8,
                    EGL_NONE);
                PointerBuffer configs = stack.mallocPointer(1);
                IntBuffer found = stack.mallocInt(1);
                if (JNI.callPPPPI(display, MemoryUtil.memAddress(configAttributes),
                    MemoryUtil.memAddress(configs), 1, MemoryUtil.memAddress(found), chooseConfig) == 0
                    || found.get(0) == 0) {
                    lastFailure = "no config (0x" + Integer.toHexString(error()) + ")";
                    JNI.callPI(display, terminate);
                    return null;
                }

                IntBuffer contextAttributes = stack.ints(
                    EGL_CONTEXT_MAJOR_VERSION, GL_MAJOR,
                    EGL_CONTEXT_MINOR_VERSION, GL_MINOR,
                    EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT,
                    EGL_NONE);
                context = JNI.callPPPPP(display, configs.get(0), 0L,
                    MemoryUtil.memAddress(contextAttributes), createContext);
                if (context == 0L) {
                    lastFailure = "eglCreateContext 0x" + Integer.toHexString(error());
                    JNI.callPI(display, terminate);
                    return null;
                }

                IntBuffer surfaceAttributes = stack.ints(
                    EGL_WIDTH, surfaceWidth(), EGL_HEIGHT, surfaceHeight(), EGL_NONE);
                surface = JNI.callPPPP(display, configs.get(0),
                    MemoryUtil.memAddress(surfaceAttributes), createPbufferSurface);
                if (surface == 0L) {
                    lastFailure = "eglCreatePbufferSurface 0x" + Integer.toHexString(error());
                    JNI.callPPI(display, context, destroyContext);
                    JNI.callPI(display, terminate);
                    return null;
                }
                if (JNI.callPPPPI(display, surface, surface, context, makeCurrent) == 0) {
                    lastFailure = "eglMakeCurrent 0x" + Integer.toHexString(error());
                    JNI.callPPI(display, surface, destroySurface);
                    JNI.callPPI(display, context, destroyContext);
                    JNI.callPI(display, terminate);
                    return null;
                }
            }

            org.lwjgl.opengl.GL.createCapabilities();
            String renderer = org.lwjgl.opengl.GL11.glGetString(GL_RENDERER);
            String version = org.lwjgl.opengl.GL11.glGetString(GL_VERSION);
            String vendor = string(JNI.callPP(display, EGL_VENDOR, queryString));
            boolean software = renderer != null && isSoftware(renderer);
            return new Chosen(display, surface, context, index, vendor, renderer, version, software);
        }

        private void release(Chosen target) {
            JNI.callPPPPI(target.display, 0L, 0L, 0L, makeCurrent);
            JNI.callPPI(target.display, target.surface, destroySurface);
            JNI.callPPI(target.display, target.context, destroyContext);
            JNI.callPI(target.display, terminate);
        }

        private static boolean isSoftware(String renderer) {
            String lower = renderer.toLowerCase(Locale.ROOT);
            return lower.contains("llvmpipe") || lower.contains("softpipe")
                || lower.contains("swrast") || lower.contains("lavapipe");
        }

        private static String string(long address) {
            return address == 0L ? null : MemoryUtil.memUTF8(address);
        }
    }
}
