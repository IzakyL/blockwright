# Supported environment

The first release targets Ubuntu 24.04 x86_64 with glibc 2.39 and OpenSSL 3.
The Rust driver dynamically links system libraries: `libssl.so.3`,
`libcrypto.so.3`, `libgcc_s.so.1`, `libm.so.6`, and `libc.so.6`.
`os: linux` and `cpu: x64` alone do not guarantee compatibility with another distro.
Alpine/musl and other OS/CPU combinations are not supported.

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

Reserve several GB of disk space for game assets, dependencies and temporary worlds.
The first launch downloads assets and can take several minutes. Build and runtime
HTTP access must reach Maven Central, NeoForge, Mojang and configured mod URLs.

The `live/` configs explicitly accept the EULA for repository integration tests.
Read the Minecraft EULA before choosing to execute them. User-facing examples
leave acceptance disabled until the user opts in.
