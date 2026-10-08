# @izakyl/blockwright-ui

UI adapter contracts, selectors, observation formatting and interaction host. Minecraft users normally start with the Minecraft UI host.

```sh
npm install @izakyl/blockwright-ui
```

Linux x64 only, Node >=22.14, ESM. The initial native release targets Ubuntu 24.04
(glibc 2.39, OpenSSL 3). Game launches need a Java 21 JDK and client graphics libraries.
Minecraft 1.21.1 / NeoForge 21.1.233 is the supported game pair.
The published client dependency includes the driver and agents; Rust and Gradle
are not required by package consumers.

## Example

```ts
import { ui } from '@izakyl/blockwright-minecraft';
const host = ui.host();
// Pass host to evidence.observe(client, { server, ui: host }).
```

Any additional packages imported by the example must also be installed explicitly.
Game examples require a `blockwright.toml` with explicit EULA acceptance.
See [setup and configuration](https://github.com/IzakyL/blockwright#quick-start),
[environment requirements](https://github.com/IzakyL/blockwright/blob/master/docs/environment.md),
and [the complete Playwright example](https://github.com/IzakyL/blockwright/tree/master/examples/playwright).

MIT licensed; see LICENSE. Native dependency notices are shipped in
`@izakyl/blockwright-client/dist/third-party/`.
