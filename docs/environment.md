# Supported environment

The first release targets Ubuntu 24.04 x86_64 with glibc 2.39 and OpenSSL 3.
The Rust driver dynamically links system libraries: `libssl.so.3`,
`libcrypto.so.3`, `libgcc_s.so.1`, `libm.so.6`, and `libc.so.6`.
Package OS metadata permits Windows candidate installation; it does not certify
another Linux distribution or complete Windows game compatibility. Alpine/musl
and other OS/CPU combinations remain outside the supported release matrix.

Use Node >=22.14 (CI exercises Node 22 and the pinned Node 24 build version),
a Java 21 **JDK**, and a working OpenGL/EGL implementation for client launches.
The supported game pair is Minecraft 1.21.1 + NeoForge 21.1.233. Other NeoForge
versions are not covered by the release checks despite the agent's loader range.

On Ubuntu 24.04, the following covers the build and software-rendering test setup:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev openjdk-21-jdk \
  libegl1 libgl1 libgl1-mesa-dri libx11-6 libxrandr2 libxcursor1 libxi6 \
  libxinerama1 libxxf86vm1 libasound2t64 ffmpeg
```

Build tools and libssl-dev are only needed by contributors. FFmpeg is required
for video/audio encoding, not basic world control. `device = "software"` selects
software offscreen rendering; `device = "auto"` allows automatic device selection.
Headless clients still need the native graphics and audio libraries.

`java` is resolved from PATH. Check `java -version` and `javac -version`; both must
be Java 21. Set `[neoforge.java] runtime` when multiple installations exist.

Use a UTF-8 locale for Linux paths containing non-ASCII characters. Minimal
containers may default to `C`, under which Java/Javac can reject a Unicode path.
For the current validation shell and its child processes, set:

```sh
export LANG=C.UTF-8 LC_ALL=C.UTF-8
```

This does not edit the host's global locale configuration. Verify that the chosen
UTF-8 locale exists in the environment where the JDK runs.

Reserve several GB of disk space for game assets, dependencies and temporary worlds.
The first launch downloads assets and can take several minutes. Build and runtime
HTTP access must reach Maven Central, NeoForge, Mojang and configured mod URLs.

The `live/` configs explicitly accept the EULA for repository integration tests.
Read the Minecraft EULA before choosing to execute them. User-facing examples
leave acceptance disabled until the user opts in.

The manual **Live game smoke** workflow runs on Ubuntu 24.04 after explicit EULA
acceptance. It runs `coverage.spec.ts`, `lifecycle.spec.ts`, `offscreen.spec.ts`
and `test-fixtures.spec.ts` with one worker and a 60-minute job budget. Line and
JSON reporters preserve `test-results/linux-report.json`; the artifact upload
runs even when a test fails. This describes the workflow configuration, not a
completed GitHub run.

## Windows development candidate

The candidate targets Windows 11 x64, Node 22.14.0 or the pinned Node 24 build,
Minecraft 1.21.1 / NeoForge 21.1.233, and a Java 21 **JDK**. A logged-in interactive
desktop and a GPU driver capable of an OpenGL 3.2 core context are required for
clients. Windows uses a hidden native window; a Windows service session or a
hosted CI runner does not qualify the client rendering path. Disconnected RDP,
Windows Server without a desktop, ARM64 and UNC game roots remain unqualified.

Set `neoforge.client.display.device` to `"auto"` or `"gpu"`. Windows rejects
`"software"` and `"index:<n>"` before downloading the game; the operating system
selects the GPU. Renderer and context information are recorded in the trace.
Put FFmpeg and ffprobe on PATH for video/audio encoding and verification, or
supply absolute executable paths to media APIs that accept tool options.

If Java 21 is not the default on PATH, set its executable in `blockwright.toml`.
Replace the example path with your installed JDK; forward slashes avoid TOML
backslash escaping and preserve spaces:

```toml
[neoforge.java]
runtime = "C:/Program Files/Java/jdk-21/bin/java.exe"

[neoforge.client.display]
device = "gpu"
```

Use `runtime = "java"` when PATH already resolves the intended Java 21 JDK. Merge
these keys into existing tables instead of declaring the same TOML table twice.

Use ordinary drive-letter absolute paths such as `C:/project` for the checkout,
game root, JDK and classpath. Do not supply an explicit `\\?\` prefix for a game
root, JAR/directory classpath or `-jar` entry: Java 21 qualification found failures
for prefixed classpath and main-JAR paths, even though prefixed file input/output
paths and an `@argfile` worked with an ordinary classpath. Explicit extended-prefix
game roots and UNC game runtime are outside the first release scope; support for
every path beyond `MAX_PATH` is not qualified. The long-classpath argument-file
check is a separate qualification.

Java 21's Windows launcher reads argument files using the system ANSI code page
(ACP). Account names, the checkout, Java installation, store, mods and runtime
paths must be representable in that code page. Spaces are quoted, and Chinese
paths work only when the active code page can encode their characters. Unsupported
characters produce a launch error; universal Unicode path support is not claimed.
The Windows UTF-8 system locale is another possible environment, but Blockwright
does not change the machine's locale. Prefer a local, representable path.

Keep separate Windows and WSL/Linux stores and instance roots. Do not use both
drivers against one `.blockwright-store` or `.blockwright` tree; native libraries,
runtime caches, process identities and file ownership belong to their platform.
Windows instances use independent file copies so changing or deleting one cannot
alter a shared read-only cache object.

The complete six-package bundle contains both native targets and one shared set
of Java agents. Package consumers need neither Rust nor Gradle. Windows release
builds statically link the MSVC C runtime and validate PE imports, so they do not
require a separate Visual C++ runtime installation. Rust/MSVC/Gradle are build
requirements for contributors, as described in [Contributing](../CONTRIBUTING.md).
Incomplete development bundles cannot pass final packaging checks.

For an explicitly managed driver, await `driver.closeAsync()` to finish saves,
process cleanup and output draining. Its default budget is 75 seconds, configurable
with `closeTimeoutMs`; timeout or abnormal driver exit rejects. The older `close()`
starts that same operation synchronously. Game, pair, fixture and MCP teardown
await driver cleanup; forced termination is not reported as a successful save.
The default game close grace is 30 seconds (`graceMs` overrides it). Unix retains
SIGTERM followed by bounded SIGKILL, including the EGL client's exit path;
Windows uses the internal shutdown request before forced process-tree cleanup.
Driver signal/EOF teardown also has its separate 60-second total budget.

The manual **Windows GPU qualification (candidate)** workflow requires explicit
Minecraft EULA acceptance and a self-hosted runner labeled `Windows`, `X64`,
`blockwright-gpu`, and `interactive-desktop`. Start that runner in the logged-in
user's desktop, with Java 21, Rust/MSVC and FFmpeg available. It runs
`windows-support.spec.ts`, `windows-qualification.spec.ts`, `coverage.spec.ts`,
`lifecycle.spec.ts`, `offscreen.spec.ts` and `test-fixtures.spec.ts` from `live/`
with one worker and a 90-minute job budget. This includes repeated pair cleanup,
startup cancellation, timeout/fatal-error evidence, path/snippet, MCP, cinema,
coverage and fixture failure attachments. Line and JSON reporters write
`test-results/windows-report.json`, and root `test-results/` evidence is uploaded
even when a test fails. This workflow has not yet been verified by a GitHub run.
Set `BLOCKWRIGHT_WINDOWS_UNICODE_PATH=1` in the qualification process only on a
host whose ACP can encode the Chinese test path. Optional
`BLOCKWRIGHT_QUALIFICATION_FFMPEG` selects an absolute encoder path, including
paths with spaces, for the media qualification. The default leaves that extra
path case disabled; ordinary capture still uses FFmpeg on PATH.
Ordinary Windows CI checks builds, helpers and installation only. Local results
do not replace actual GitHub workflow execution or the remaining fault checks.
The current candidate has completed local Windows/Ubuntu 24.04 build and
installed-package checks, including independent consumer TypeScript compilation.
The final Windows suite completed with 16 normal passes, one expected fixture
failure and two Linux-only skips, with no unexpected failures or retries. Its ten
complete client/server rounds saved and cleaned up successfully. The same six
archives passed the Ubuntu 24.04 userland game suite (eight normal passes and one
expected failure) in an isolated Docker container sharing an Arch host kernel.
All test game processes and registry entries were checked after completion.
Window sampling observed no visible or foreground client windows across all ten
rounds; the measured maximum interval was 1025ms, so it does not exclude changes
between samples. Actual GitHub execution and real Windows disk exhaustion remain
unverified. See the [Windows validation record](windows-validation.md); the
published support matrix remains unchanged.
