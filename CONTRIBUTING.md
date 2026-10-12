# Contributing

Use Linux x64 and the environment described in [docs/environment.md](docs/environment.md).
The repository pins Rust in `rust-toolchain.toml`, Node in `.nvmrc`, npm in
`package.json`, and Gradle in both projects' checked-in wrappers. Use a Java 21 JDK.

```sh
npm ci
npm test
npm run typecheck:live
cargo test --locked
npm run test:java
```

`npm ci` does not compile native components. To build the bundled driver and JARs:

```sh
npm run build:release
npm run pack:check
```

`pack:check` installs all six archives in a temporary directory outside the
workspace, checks imports and declarations, reads packaged Java sources, runs a
driver ping and verifies MCP CLI execution and a protocol handshake. Verified
archives are copied into ignored `release/`. It needs registry access for external
dependencies. No publish operation runs as part of these commands.

For game integration tests, read the EULA first, then use `npm run test:live`.
These tests download and launch real games; use `-- --workers=1` to limit resource
usage. For a shorter fixture smoke test:

```sh
npm run test:live -- live/test-fixtures.spec.ts --workers=1
```

Keep package versions synchronized with `npm run version:release -- VERSION`.
Update the changelog for user-visible changes. Add regression tests for behavioral
changes and preserve the Linux x64 release boundary until another platform has
native implementations and an installation test.

Do not commit runtime worlds, caches, credentials, local `.env` files or generated
archives. CI scans Git history for secrets with Gitleaks. Report vulnerabilities
using the process in [SECURITY.md](SECURITY.md).
