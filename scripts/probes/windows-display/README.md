# Windows display and audio probe

Run from a Windows x64 desktop session with Java/Javac 21:

```powershell
./scripts/probes/windows-display/run.ps1
```

This independent program downloads the eight LWJGL core/GLFW/OpenGL/OpenAL jars
selected by Minecraft 1.21.1's official metadata, verifies their SHA-1 checksums,
and compiles and runs without downloading or starting Minecraft. The dependency
metadata, environment record, classes, jars and results are written to the ignored
`build/` directory beside the script.

Each iteration creates an OpenGL 3.2 core Win32/WGL hidden window, checks native
visibility and foreground state on every frame, processes events, reads changing
RGBA pixels from its own framebuffer, and destroys the context and window. It
then opens an OpenAL Soft loopback device, renders a synthesized tone at 48 kHz
stereo float32, checks its samples, and closes the context and device. Defaults
are five iterations of 120 frames; use `-Iterations` and `-Frames` for longer runs.

The result establishes the independent backend's feasibility on the recorded GPU
and driver. Minecraft window hooks, input, screenshots, recordings, world state
and complete game shutdown still require the integration/live tests in the Windows
support plan. Keep the desktop session active; this probe does not establish
support for Windows services, disconnected RDP sessions, other GPUs or Linux EGL.

The hidden-window design follows the [GLFW context guide](https://www.glfw.org/docs/3.4/context_guide.html#context_offscreen).

After running the probe, exercise the production agent backend on the same GPU:

```powershell
cd neoforge-agent
./gradlew.bat test --tests dev.blockwright.agent.ClientOffscreenTest -I ../scripts/probes/windows-display/native-agent-test.gradle --no-daemon
```

The explicit Gradle init script enables the desktop-GPU test and supplies the
probe's verified Windows jars. Ordinary Java tests skip that GPU test.

## Recorded probe result

2026-10-15: Windows 11 Pro build 26300, OpenJDK 21.0.2, NVIDIA RTX 4070,
driver 32.0.16.1088 (OpenGL reports NVIDIA 610.88). The metadata selected LWJGL
3.3.3+5, GLFW 3.4.0 and OpenAL Soft 1.23.1. Five complete iterations of 120 frames
passed changing FBO pixel readback, positive 320x240 framebuffer dimensions,
native visibility and foreground checks, event processing, context destruction
and audio device closure. Synthesized loopback audio RMS was 0.2056546401 at
48 kHz stereo float32. Raw environment/checksum and stdout records are in the
ignored `build/environment.json` and `build/result.txt` files.

The production `ClientOffscreenTest` also passed on that machine with its GPU
opt-in enabled: WGL hidden-window setup, real FBO pixel readback, context release,
and the production `ClientAudio` thread publishing a non-silent synthesized
48 kHz stereo float32 block through `Hooks.AUDIO_MIXED` while EGL is disabled.
The full Java suite passed 74 tests with no failures or skipped tests, and
`compileModulesJava` plus the production agent JAR build completed successfully.
