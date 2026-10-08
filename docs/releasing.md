# Releasing Blockwright

Only the five packages under `packages/` are published; the root workspace stays
`private: true`. Publishing requires write access to the `@izakyl` npm scope.

## Verify locally

Use the pinned tools on Ubuntu 24.04 x64 with Java 21. From a clean checkout:

```sh
npm ci
npm run release:check
```

This runs TypeScript and Rust tests, live type checking, clean TypeScript/native
builds, Java tests and Java-module compile checks, then packs and installs all five
archives in a temporary consumer project. CLI execution, MCP handshake, bundled
Java source loading, declaration resolution and native driver ping must pass.
All builds are strict: missing/old JARs, mismatched versions, modified native
artifacts and stale source hashes fail. `npm pack` checks package inputs and
compiles TypeScript; native changes require `npm run build:release` first.

Review `release/*.tgz` and `release/verified.json`. Run the live fixture smoke or
the full live suite after accepting the Minecraft EULA. The manual Live game
smoke workflow provides an explicit acceptance input and uploads failure evidence.
Routine CI does not launch or accept terms for Minecraft.

For another version:

```sh
npm run version:release -- 0.1.1
```

Review package manifests, Cargo.lock and both Gradle versions, and update
CHANGELOG.md. The MCP server reads its version from its package metadata.
Re-run verification after version changes.

## First publication

npm trusted publishing can only be configured for packages that already exist, so
the first version of each package is published by hand from the verified archives,
in dependency order:

1. `@izakyl/blockwright-client`
2. `@izakyl/blockwright-ui`
3. `@izakyl/blockwright-minecraft`
4. `@izakyl/blockwright-test`
5. `@izakyl/blockwright-mcp`

Use `npm publish release/<archive>.tgz --access public` for each archive, with
`--tag next` for prereleases.

Then, in each package's npm settings, trust this GitHub repository, `release.yml`
and the `npm` environment (see npm's [trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/)),
and create the `npm` environment in GitHub with any reviewer rules you want. The
workflow uses `id-token: write` and needs no long-lived npm token; provenance is
generated automatically.

## Subsequent releases

Commit the verified source and create a `vVERSION` tag matching every package.
Select that tag in GitHub's Release workflow. The default `publish=false` verifies
and uploads archives without publishing; explicitly set it true for publication.
The workflow first completes CI, including both Node installation checks and the
history scan, then publishes the same verified archives in dependency order.
It checks tag/version agreement and archive hashes before writing to npm.

Publishing five packages is not atomic. If a publish fails partway, check which
packages reached the registry and publish only the missing ones from the same
verified archives. A published npm version cannot be replaced, so do not bump the
version to retry.

## License and build maintenance

Update coverage-report/THIRD_PARTY.md and its license texts when Java dependencies
change. The coverage JAR preserves distinct license texts and upstream notices;
the client bundle additionally generates a Cargo dependency/license inventory.
Re-run installation checks if the compiler, OpenSSL baseline or bundled artifacts
change. Only list another distribution as supported after its installed-package
and game tests pass.
