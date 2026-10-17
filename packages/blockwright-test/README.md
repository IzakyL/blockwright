# @izakyl/blockwright-test

Playwright fixtures that launch a Minecraft client/server pair and attach failure evidence.

```sh
npm install @izakyl/blockwright-test
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
import { createGameTest, expect } from '@izakyl/blockwright-test';
import { world } from '@izakyl/blockwright-minecraft';

const test = createGameTest({ config: 'blockwright.toml' });
test.setTimeout(600_000);

test('places a block in the test world', async ({ server }) => {
  const pos = { x: 0, y: -60, z: 0 };
  await world.command(server, 'setblock 0 -60 0 minecraft:diamond_block');
  expect((await world.block(server, pos)).id).toBe('minecraft:diamond_block');
});
```

Any additional packages imported by the example must also be installed explicitly.
Game examples require a `blockwright.toml` with explicit EULA acceptance.
See [setup and configuration](https://github.com/IzakyL/blockwright#quick-start),
[environment requirements](https://github.com/IzakyL/blockwright/blob/master/docs/environment.md),
and [the complete Playwright example](https://github.com/IzakyL/blockwright/tree/master/examples/playwright).

MIT licensed; see LICENSE. Native dependency notices are shipped in
`@izakyl/blockwright-client/dist/third-party/`.
