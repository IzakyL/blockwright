# Releasing Blockwright

Only the six packages under `packages/` are published; the root workspace stays
`private: true`. Publishing requires write access to the `@izakyl` npm scope.

## Verify locally

Use the pinned tools on Ubuntu 24.04 x64 with Java 21. From a clean checkout:

```sh
npm ci
npm run release:check
```

This runs TypeScript and Rust tests, live type checking, clean TypeScript/native
builds, Java tests and Java-module compile checks, then packs and installs all six
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

## Publish

Publishing is done by hand, from the archives `release:check` verified. Commit the
verified source and create a `vVERSION` tag matching every package, then publish the
archives in dependency order:

1. `@izakyl/blockwright-client`
2. `@izakyl/blockwright-ui`
3. `@izakyl/blockwright-minecraft`
4. `@izakyl/blockwright-test`
5. `@izakyl/blockwright-mcp`
6. `@izakyl/blockwright-cinema`

```sh
npm login
for p in client ui minecraft test mcp cinema; do
  npm publish ./release/izakyl-blockwright-$p-VERSION.tgz --access public --tag next
done
```

Keep the leading `./`: without it npm reads `release/<archive>.tgz` as a GitHub
`owner/repo` shorthand and refuses it. Use `--tag next` for prereleases and
`--tag latest` otherwise. The first version of a new package is tagged `latest`
whatever `--tag` says; move a tag afterwards with `npm dist-tag add`.

Check `release/verified.json` before publishing: its version and archive hashes must
match what `release:check` just produced.

Publishing six packages is not atomic. If a publish fails partway, check which
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
