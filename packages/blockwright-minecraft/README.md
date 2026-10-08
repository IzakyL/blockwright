# @izakyl/blockwright-minecraft

Typed Minecraft world, client, media and UI operations. Includes Java source modules compiled inside the game.

```sh
npm install @izakyl/blockwright-minecraft
```

Linux x64 only, Node >=22.14, ESM. The initial native release targets Ubuntu 24.04
(glibc 2.39, OpenSSL 3). Game launches need a Java 21 JDK and client graphics libraries.
Minecraft 1.21.1 / NeoForge 21.1.233 is the supported game pair.
The published client dependency includes the driver and agents; Rust and Gradle
are not required by package consumers.

## Example

```ts
import { launchGame, world } from '@izakyl/blockwright-minecraft';
const game = await launchGame({ config: 'blockwright.toml' });
try {
  await world.command(game.server, 'setblock 0 -60 0 minecraft:diamond_block');
  console.log(await world.block(game.server, { x: 0, y: -60, z: 0 }));
} finally {
  await game.close();
}
```

Any additional packages imported by the example must also be installed explicitly.
Game examples require a `blockwright.toml` with explicit EULA acceptance.
See [setup and configuration](https://github.com/IzakyL/blockwright#quick-start),
[environment requirements](https://github.com/IzakyL/blockwright/blob/master/docs/environment.md),
and [the complete Playwright example](https://github.com/IzakyL/blockwright/tree/master/examples/playwright).

MIT licensed; see LICENSE. Native dependency notices are shipped in
`@izakyl/blockwright-client/dist/third-party/`.
