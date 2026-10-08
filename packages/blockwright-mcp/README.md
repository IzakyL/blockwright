# @izakyl/blockwright-mcp

MCP stdio server for Minecraft automation. Exposes world control, observation, screenshots, Java tasks and Playwright test export.

```sh
npm install @izakyl/blockwright-mcp
```

Linux x64 only, Node >=22.14, ESM. The initial native release targets Ubuntu 24.04
(glibc 2.39, OpenSSL 3). Game launches need a Java 21 JDK and client graphics libraries.
Minecraft 1.21.1 / NeoForge 21.1.233 is the supported game pair.
The published client dependency includes the driver and agents; Rust and Gradle
are not required by package consumers.

## CLI

```sh
npm install @izakyl/blockwright-mcp
npx blockwright-mcp --help
npx blockwright-mcp --cwd /absolute/project --config blockwright.toml
```

Configure your MCP host with the project's absolute `node_modules/.bin/blockwright-mcp`
path as `command` and the options above as `args`. Protocol traffic uses stdio.
No game starts until `blockwright_launch` is called. Default capabilities are
`core,vision,query`; opt into recording with `--caps core,vision,query,record`.
Java tasks execute code with your account's permissions.

Screens are read through the vanilla adapter. To add a mod's UI library, pass
`--ui-adapter PATH` (repeatable, relative to `--cwd`): a module whose default export
is a UI adapter or an array of them.

Any additional packages imported by the example must also be installed explicitly.
Game examples require a `blockwright.toml` with explicit EULA acceptance.
See [setup and configuration](https://github.com/IzakyL/blockwright#quick-start),
[environment requirements](https://github.com/IzakyL/blockwright/blob/master/docs/environment.md),
and [the complete Playwright example](https://github.com/IzakyL/blockwright/tree/master/examples/playwright).

MIT licensed; see LICENSE. Native dependency notices are shipped in
`@izakyl/blockwright-client/dist/third-party/`.
