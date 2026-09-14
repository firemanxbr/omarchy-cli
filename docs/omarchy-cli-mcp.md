# omarchy-cli as an MCP server

`omarchy-cli mcp` serves the client's answers as tools over the Model Context
Protocol (stdio transport: one JSON-RPC 2.0 message per line on stdin and
stdout), so an assistant running on the machine can reason about the ring
and the system without shelling out and parsing text. Everything is
**read-only** — the tools answer, they never install, upgrade or pin.

| Tool | Arguments | Answers |
|---|---|---|
| `status` | — | the ring, the pinned release, the head the ring serves now, how many installed packages come from it, the pending updates |
| `check` | `targets: string[]` | the plan (install / upgrade per package), the ABI findings against this system's libraries (`safe`, blockers = symbol versions it cannot satisfy), the libalpm hooks pacman would run |
| `info` | `package` | the manifest as the ring publishes it: version, description, dependencies, provides, ABI needs, embedded libraries, size, checksum, mirror URL, the release, and `seal` — where the object came from and the proof (the factory chain with audit, approval and attestation, or the upstream project and keyring) |
| `search` | `query` | packages whose name or description contains it |
| `list` | — | installed packages the ring also serves, each `current`, `update` or `ahead` |
| `security` | — | installed packages with an open advisory (severity, CVEs, exploited in the wild, EPSS) and whether an upgrade from the ring fixes each |

The shapes are exactly what `omarchy-cli <command> --json` prints; every
tool result carries them as `structuredContent` and, pretty-printed, as
text. Errors (a package not in the ring, the pool unreachable) come back as
tool results with `isError`, never as protocol errors, so the session goes on.

Register it the way the assistant expects a stdio server, for example:

```json
{ "mcpServers": { "omarchy": { "command": "omarchy-cli", "args": ["mcp"] } } }
```

`--ring`, `--api`, `--arch` and `--root` before `mcp` apply to every tool of the
session, as they do to any command; the config file
([`omarchy-cli.config.toml`](omarchy-cli.config.toml)) supplies the rest.
