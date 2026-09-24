---
name: music-mcp-ops
description: >-
  Install, configure, and health-check the music MCP servers in this project on
  Windows: qqmusic-mcp (QQ Music library read/write), navidrome (self-hosted
  library over the Subsonic API), foo_ai (foobar2000 playback control), fleapit
  and torrent-search-mcp (release metadata search), and fluxdown (downloads).
  Covers installing the foobar2000 player and its MCP component, editing
  .cursor/mcp.json, and verifying each server actually connects and lists its
  tools. Use when the user asks to install or configure a music MCP service,
  wire up foobar2000 playback control, add or fix a server in .cursor/mcp.json,
  or check whether the MCP services are working, connected, broken, or showing
  as disconnected in Cursor.
disable-model-invocation: true
---

# Music MCP Operations

Windows-only project. Several local MCP servers are wired into `.cursor/mcp.json`;
see [Services and which skill owns them](#services-and-which-skill-owns-them) for
the full list and the skill that drives each one.

## Ground rules

- This project manages the user's **own accounts, own library, and its own downloads directory**. It searches release metadata and stages downloads into `downloads/` — it does not host, seed, or redistribute anything. See the `music-metadata-search` skill for the search/download flow.
- **Supported services are an allowlist:** `qqmusic-mcp`, `navidrome`, `foo_ai` (library and playback), `fleapit`, `torrent-search-mcp` (release metadata search), `fluxdown` (downloads). The verifier probes only these and reports anything else in `mcp.json` as `SKIP`. Adding a service means extending the allowlist in both this skill and `scripts/verify-mcp.ps1`.
- `authorized_tokens.json` holds live login sessions. It is gitignored — never commit it, never print its contents, never paste tokens into chat.
- The FluxDown bearer token lives in `.cursor/mcp.json` under the `fluxdown` server's `headers`. Read it from there when a raw API call is needed; never echo it anywhere.
- Project-scoped servers require manual approval in Cursor **Settings > MCP**. A server that is configured but "disconnected" is often just unapproved, not broken.
- Installing software mutates the user's machine. Confirm before installing a player, a component, or a global CLI tool.

## Services and which skill owns them

| Service | Transport | Purpose | Owning skill |
|---|---|---|---|
| `qqmusic-mcp` | stdio | QQ Music library read/write (playlists, lyrics, analysis) | — |
| `navidrome` | stdio | Self-hosted library search via Subsonic API | — |
| `foo_ai` | SSE, bridged to stdio | foobar2000 playback control | `music-download-pipeline` (library sync) |
| `fleapit` | stdio | Nyaa release metadata search (music under `category: anime`) | `music-metadata-search` |
| `torrent-search-mcp` | stdio | Multi-source release metadata search | `music-metadata-search` |
| `fluxdown` | HTTP + bearer | Downloads into `downloads/` | `music-download-pipeline` |
| `fileclaw` | stdio | Not driven by any skill here | — |

## Workflow

Copy this checklist and track progress:

```
- [ ] Step 1: Inspect current state (read mcp.json, run the verifier)
- [ ] Step 2: Install the player and component (foobar2000 only, if requested)
- [ ] Step 3: Install the MCP server
- [ ] Step 4: Write the .cursor/mcp.json entry
- [ ] Step 5: Verify end to end with the verifier script
- [ ] Step 6: Hand off (reload Cursor, approve server, keep player running)
```

### Step 1: Inspect current state

Read `.cursor/mcp.json`, then run the verifier. It parses the config and probes every
declared server with a real MCP handshake:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/music-mcp-ops/scripts/verify-mcp.ps1
```

The script prints one `PROBE_RESULT` JSON line per server and a final pass/fail table.
Exit code is 0 only when every server is healthy.

### Step 2: Install the player and component

Only needed for playback control. See [services.md](services.md#foo_ai--foobar2000) for the
full procedure and the component-directory trap.

### Step 3: Install the MCP server

Per-service install commands are in [services.md](services.md). Prefer the package manager
(`uv tool install`, `npm`, `scoop`) over hand-placed binaries.

### Step 4: Write the .cursor/mcp.json entry

Keep the existing entries intact — add, don't replace. Use absolute Windows paths for
`command` when a tool is not guaranteed to be on `PATH`, and wrap `npx` as
`cmd /c npx ...` so Cursor can launch the batch shim.

### Step 5: Verify end to end

Re-run the verifier. A server is only healthy when it completes `initialize` **and**
returns a non-empty `tools/list`. Config that merely parses proves nothing.

### Step 6: Hand off

Tell the user to reload Cursor (or toggle the server in Settings > MCP) and to approve the
server. For `foo_ai`, remind them the MCP server runs **inside** the foobar2000 process, so
closing the player takes the server down.

## Critical gotchas

These cost real debugging time. Check them before inventing new theories.

1. **Cursor cannot connect to SSE-only MCP servers directly.** It sends `POST` first, gets
   `404` from an SSE-only server, and does **not** fall back to the SSE `GET` handshake.
   Setting `transportType: "sse"` has no effect. Bridge it with `mcp-remote`:

   ```json
   {
     "command": "cmd",
     "args": ["/c", "npx", "-y", "mcp-remote", "http://localhost:9910/sse", "--transport", "sse-only"]
   }
   ```

   Diagnose with: `GET <url>` returns 200, `POST <url>` and `POST <url>/mcp` return 404.

2. **foobar2000 component directory is architecture-specific.** A 64-bit portable install
   loads user components from `profile\user-components-x64\<name>\<name>.dll`. The 32-bit
   install uses `profile\user-components\`. Put a component in the wrong one and it is
   **silently not loaded** — no error dialog. Never use the app folder's `components\`
   directory; that is for official built-ins only.

3. **`.fb2k-component` packages ship multiple architectures.** Extract the DLL matching the
   player, not the first one in the archive.

4. **`foo_ai` binds IPv6 loopback only.** It listens on `::1`, so
   `http://127.0.0.1:9910/sse` fails while `http://localhost:9910/sse` and
   `http://[::1]:9910/sse` work.

5. **scoop keeps player state outside the app folder.** `current\profile` is a junction to
   `scoop\persist\<app>\profile`, so components installed there survive app updates. Check
   `LinkType` / `Target` if paths look surprising.

6. **A "disconnected" server is usually a transport or approval problem**, not a config
   syntax problem. Confirm transport shape and approval state before editing JSON.

## Reference

- [services.md](services.md) — per-service install commands, config snippets, verification, and troubleshooting tables
- `scripts/verify-mcp.ps1` — health-check runner (execute it)
- `scripts/probe-mcp-stdio.js` — generic stdio MCP probe (invoked by the runner)
