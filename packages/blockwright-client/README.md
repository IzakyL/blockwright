# @izakyl/blockwright-client

Native Rust driver, Java agents and low-level TypeScript API for launching and controlling Minecraft instances.

```sh
npm install @izakyl/blockwright-client
```

Released baseline: Linux x64, Node >=22.14, ESM. The initial native release targets Ubuntu 24.04
(glibc 2.39, OpenSSL 3). Game launches need a Java 21 JDK and client graphics libraries.
Minecraft 1.21.1 / NeoForge 21.1.233 is the supported game pair.
The published client dependency includes the driver and agents; Rust and Gradle
are not required by package consumers.

Windows 11 x64 is a development candidate, pending complete installed-package,
real-game and Linux regression qualification. Candidate clients use an interactive
GPU desktop with `device = "auto"` or `"gpu"`; software/index modes are rejected.
Java 21 paths must be representable in the Windows system code page, and Windows
and WSL need separate stores. The complete bundle includes both native targets
and shared agents, with static Windows CRT; consumers need no Rust, Gradle or
separate Visual C++ runtime. See the [candidate setup](https://github.com/IzakyL/blockwright/blob/master/docs/environment.md#windows-development-candidate).

## Example

```ts
import { BlockwrightDriver } from '@izakyl/blockwright-client';
const driver = new BlockwrightDriver();
try {
  console.log(await driver.ping());
} finally {
  await driver.closeAsync();
}
```

Any additional packages imported by the example must also be installed explicitly.

`closeAsync()` waits for saves, native process cleanup and output draining; repeated
calls share one promise. The synchronous `close()` starts it without waiting.
`closeTimeoutMs` defaults to 75000; timeout and abnormal exit reject. Pair and game
teardown already await this operation, and `closeQuietly` prefers it when present.
Game examples require a `blockwright.toml` with explicit EULA acceptance.
See [setup and configuration](https://github.com/IzakyL/blockwright#quick-start),
[environment requirements](https://github.com/IzakyL/blockwright/blob/master/docs/environment.md),
and [the complete Playwright example](https://github.com/IzakyL/blockwright/tree/master/examples/playwright).

MIT licensed; see LICENSE. Native dependency notices are shipped in
`@izakyl/blockwright-client/dist/third-party/`.
