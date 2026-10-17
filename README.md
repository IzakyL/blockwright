# Blockwright

Blockwright automates real Minecraft client and server instances for mod testing.
Use TypeScript to control the world, inspect UI, capture evidence, and run Java
snippets inside the game. Playwright fixtures provide repeatable tests; the MCP
server exposes the same workflow to compatible assistants.

**Initial support: Linux x64, Minecraft 1.21.1, NeoForge 21.1.233, Java 21.**
The npm packages are ESM. The native release baseline is Ubuntu 24.04 (glibc 2.39,
OpenSSL 3); other distributions, musl/Alpine, ARM, macOS and Windows are not in the
supported release matrix. See [environment setup](docs/environment.md).

Windows 11 x64 is a development candidate with a hidden GPU window. Qualification
and packaging work is tracked in the [Windows plan](docs/windows-support-plan.md);
see [candidate requirements](docs/environment.md#windows-development-candidate)
and [local builds](CONTRIBUTING.md) before trying it. This does not expand the
published release support matrix yet.

| Package | Purpose |
| --- | --- |
| `@izakyl/blockwright-client` | Native Rust driver, bundled Java agents and low-level SDK |
| `@izakyl/blockwright-minecraft` | Typed world, player, UI, camera and media operations |
| `@izakyl/blockwright-ui` | Shared UI adapter contracts and interaction host |
| `@izakyl/blockwright-test` | Playwright fixtures and failure evidence |
| `@izakyl/blockwright-mcp` | MCP stdio server and `blockwright-mcp` command |
| `@izakyl/blockwright-cinema` | Camera paths, time curves and frame-stepped timelapse capture |

## Quick start

Install Node >=22.14 and a **Java 21 JDK** (runtime compilation needs the compiler).
Published npm packages include the Rust binary and agent JARs; users do not need
Rust or Gradle. Initial game setup downloads Minecraft, NeoForge and assets.

```sh
npm install --save-dev @playwright/test @izakyl/blockwright-test @izakyl/blockwright-minecraft
```

Create `blockwright.toml`:

```toml
[neoforge]
minecraft_version = "1.21.1"
loader_version = "21.1.233"

[neoforge.server]
# Read https://www.minecraft.net/eula before explicitly accepting it.
eula = false
world = "flat"

[neoforge.client.display]
device = "software"
```

Set `eula = true` if you accept the Minecraft EULA. Without explicit acceptance,
server launch fails. Java is resolved from PATH; an alternative executable can be
set in `[neoforge.java] runtime = "/path/to/java"`.

Create `smoke.spec.ts`:

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

Run `npx playwright test smoke.spec.ts --workers=1`. No browser installation is
needed. The fixture launches a client and server, captures evidence on failure,
and closes both afterwards. Ticks start frozen for deterministic tests; use
`tick` operations when the game needs to advance. A complete configuration is in
[examples/playwright](examples/playwright/README.md).

## MCP

Install `@izakyl/blockwright-mcp` in your project and configure your MCP host:

```json
{
  "mcpServers": {
    "blockwright": {
      "command": "/absolute/path/to/project/node_modules/.bin/blockwright-mcp",
      "args": ["--cwd", "/absolute/path/to/project", "--config", "blockwright.toml"]
    }
  }
}
```

Run `npx blockwright-mcp --help` to list options. The protocol uses stdio. The
`blockwright_launch` tool starts the game on demand; initializing the MCP server
does not start Minecraft. See [the MCP package](packages/blockwright-mcp/README.md).

## Runtime behavior

Instances and downloads live in `.blockwright/` and `.blockwright-store/` beneath
the working directory. Test artifacts go to `test-results/`. These directories
are local runtime data, not source or release files. Minecraft is downloaded at
runtime and is not bundled in the npm packages.

Test servers default to `online-mode=false` and `server-ip=127.0.0.1`. Use explicit
`[neoforge.server.properties]` overrides if you need another bind address or
online authentication. Game tasks and loaded mods execute code with your user
account's permissions; use trusted configurations and modules.

## Development and releases

See [CONTRIBUTING.md](CONTRIBUTING.md), [release instructions](docs/releasing.md),
the [Java API](neoforge-agent/API.md), and the [Minecraft prefab guide](packages/blockwright-minecraft/PREFAB.md).
This is a pre-1.0 API; changes are recorded in [CHANGELOG.md](CHANGELOG.md).

Blockwright is MIT licensed. Included dependencies retain their own licenses;
native bundles include `dist/third-party/` and the coverage JAR includes its
license texts. See [third-party inventory](coverage-report/THIRD_PARTY.md).
