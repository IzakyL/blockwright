# Contributing

Released builds use Linux x64 and the environment described in [docs/environment.md](docs/environment.md).
The repository pins Rust in `rust-toolchain.toml`, Node in `.nvmrc`, npm in
`package.json`, and Gradle in both projects' checked-in wrappers. Use a Java 21 JDK.

Windows 11 x64 is a development candidate. Use the same pinned tools plus MSVC
build tools, a logged-in GPU desktop and FFmpeg for client qualification. Read the
[Windows candidate requirements](docs/environment.md#windows-development-candidate)
for device modes, JDK 21 path encoding and separate Windows/WSL stores. Passing a
hosted Windows build does not qualify real client rendering.

```sh
npm ci
npm test
npm run typecheck:live
cargo test --locked
npm run test:java
```

`npm ci` does not compile native components. For a current-platform development
bundle with the driver and JARs:

```sh
npm run build:native
npm run build:agents
npm run build:dev
```

Publishing requires both native target artifacts; follow
[docs/releasing.md](docs/releasing.md) to assemble the complete release before
running `pack:check`. It installs all six archives in a temporary directory outside the
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
