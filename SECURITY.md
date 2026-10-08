# Security

Blockwright is a local development and testing tool. Mods and Java tasks run with
the current user's permissions; they are not sandboxed. The MCP server is stdio
only. The game's automation listeners and default test server bind to loopback.
Do not expose an unauthenticated test server to an untrusted network.

For a suspected vulnerability, use GitHub's private vulnerability reporting on
this repository when enabled. If unavailable, contact the maintainer through
their GitHub profile to arrange a private channel before sharing exploit details
or credentials. Do not include secrets in public issues.

Only the latest pre-1.0 release receives fixes.
