# Services Reference

Install commands, config entries, verification, and troubleshooting for each server.
All paths and commands assume Windows with PowerShell.

## qqmusic-mcp

Local MCP server for managing a personal QQ Music library: reading playlists, lyrics and
song metadata, library analysis (duplicates, empty playlists, unorganized liked songs), and
account-level playlist writes with a write probe and per-run rollback. It deliberately does
**not** provide playback links or downloads.

Requires Windows 10/11. Uses QQ Music's unofficial web API, so upstream changes can break it.

### Install

```powershell
uv tool install "git+https://github.com/baoozak/qqmusic-mcp.git"
```

The executable lands in the uv tool bin directory (typically `%USERPROFILE%\.local\bin\qqmusic-mcp.exe`).
Resolve the exact path with `uv tool list --show-paths` rather than guessing.

### First login

```powershell
qqmusic-mcp login --force --login-timeout 600
```

Opens an isolated Chrome/Edge window. The user scans a QQ or WeChat QR code; the window closes
automatically once the session is verified. The session is encrypted with Windows DPAPI and
stored locally — it never appears in logs or MCP responses. This step **requires the user**;
do not attempt to automate the scan.

### Config entry

```json
{
  "qqmusic-mcp": {
    "command": "C:\\Users\\<user>\\.local\\bin\\qqmusic-mcp.exe",
    "args": ["stdio"]
  }
}
```

Use the absolute path: the uv tool bin directory is not always on the PATH that Cursor inherits.

### Verify

```powershell
qqmusic-mcp doctor --client cursor   # expect {"session":"valid", ...}
```

If the command is not found in the current shell, the installer updated the user PATH — open a
new shell or use the full executable path.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `session: missing` | Not logged in, or session expired | `qqmusic-mcp login --force` |
| Command not found | PATH not refreshed | Use the absolute path in config |
| Write tools unavailable | Write probe failed | Expected defensive behaviour; upstream API may have changed |
| `Event loop is closed` on first tool call | Transient startup race | Retry the call once |

## navidrome

Reads and curates a self-hosted Navidrome library through its Subsonic-compatible API:
search, playlist read/write, ratings, library browsing. Requires an existing Navidrome server.

### Install and configure

```json
{
  "navidrome": {
    "command": "cmd",
    "args": ["/c", "npx", "-y", "navidrome-mcp"]
  }
}
```

Credentials are **not** stored in `mcp.json`. On first run the server opens a local settings
page; the user fills in the Navidrome URL, username and password, tests the connection, and
saves. Settings persist in the OS config directory and load at startup only — restart the
server after changing them. Reopen the settings page any time with `npx navidrome-config`.

### Verify

The server cannot be healthy without a reachable Navidrome instance and saved settings. A
stdio handshake that lists tools proves the server starts; it does not prove the upstream
library is reachable. Confirm the Navidrome server itself is up (default port 4533) and that
the settings page saved successfully.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Server starts but tools fail | No/invalid Navidrome credentials | Reopen `npx navidrome-config`, test connection, save |
| Cannot reach library | Navidrome server not running | Start the Navidrome instance (default port 4533) |
| Settings changes ignored | Settings load at startup | Restart the MCP server |

## foo_ai / foobar2000

[foo_ai](https://github.com/Bobini1/foo_ai) is a native foobar2000 component that runs an MCP
server inside the player process, exposing playback control, library search, and playlist
read/write. Requires foobar2000 **v2.0+**. Default endpoint `http://localhost:9910/sse`;
change host/port in `Preferences > Tools > AI`. It exposes 19 tools.

### Install the player

```powershell
scoop install extras/foobar2000
```

### Install the component

1. Download the latest `.fb2k-component` from the project's Releases page.
2. Verify the SHA-256 against the release metadata before installing.
3. Extract the DLL matching the player architecture and place it at:

```
<profile>\user-components-x64\<component-name>\<component-name>.dll   # 64-bit
<profile>\user-components\<component-name>\<component-name>.dll       # 32-bit
```

For a scoop portable install, `<profile>` is `<install>\current\profile`, which is a junction
to `scoop\persist\foobar2000\profile`. Writing through the junction is correct and survives
app updates.

Determine the player architecture from the PE header rather than assuming:

```powershell
# 0x8664 = x64, 0x14C = x86
$fs = [System.IO.File]::OpenRead("$exe"); $br = New-Object System.IO.BinaryReader($fs)
$fs.Seek(0x3C, 'Begin') | Out-Null; $pe = $br.ReadInt32()
$fs.Seek($pe + 4, 'Begin') | Out-Null; '{0:X}' -f $br.ReadUInt16(); $br.Close(); $fs.Close()
```

### Config entry

Bridge the SSE endpoint to stdio — see gotcha 1 in [SKILL.md](SKILL.md#critical-gotchas):

```json
{
  "foo_ai": {
    "command": "cmd",
    "args": ["/c", "npx", "-y", "mcp-remote", "http://localhost:9910/sse", "--transport", "sse-only"]
  }
}
```

### Verify

```powershell
# 1. component actually loaded into the player process
(Get-Process foobar2000).Modules | Where-Object ModuleName -eq 'foo_ai.dll'

# 2. server listening
Get-NetTCPConnection -LocalPort 9910
```

Both must hold. Then confirm transport shape: `GET http://localhost:9910/sse` returns 200 with
`text/event-stream`, while `POST` returns 404 (expected for an SSE-only server).

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `foo_ai.dll` not in module list | Wrong component directory (arch mismatch) | Move to `user-components-x64` for 64-bit |
| Component not listed at all | DLL architecture does not match player | Extract the matching arch from the package |
| Port 9910 not listening | Player not running, or component rejected | Start the player; check `Preferences > Components` |
| `127.0.0.1` connection refused | Server binds `::1` only | Use `localhost` or `[::1]` |
| Tools missing in Cursor despite working endpoint | Cursor SSE-only transport bug | Use the `mcp-remote` bridge config above |
| Worked, then broke after closing a window | MCP server lives in the player process | Keep foobar2000 running |

## Cross-cutting checks

| Check | Command |
|---|---|
| Config parses, servers listed | `Get-Content .cursor/mcp.json -Raw \| ConvertFrom-Json` |
| Full health check | `scripts/verify-mcp.ps1` |
| Listening ports | `Get-NetTCPConnection -State Listen` |
| Process modules | `(Get-Process <name>).Modules` |
| MCP handshake + tool list | `node scripts/probe-mcp-stdio.js --timeout 90000` |

## Reading verifier output

| Status | Meaning |
|---|---|
| `PASS` | Handshake completed and tools were listed, or the auxiliary check held |
| `WARN` | Process works but is not usable yet (e.g. unconfigured credentials) |
| `FAIL` | Probed and broken; the detail names the failing stage |
| `SKIP` | Present in `mcp.json` but outside this project's supported allowlist |

`WARN` for `navidrome` is normal until the settings page has been filled in: the server
starts in setup mode and only exposes `open_settings` / `test_connection`.
