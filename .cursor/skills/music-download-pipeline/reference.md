# Reference

## FluxDown config

Local API: `http://127.0.0.1:17800/api/v1`. Authenticate with
`Authorization: Bearer <local_server_token>`. The token lives in `.cursor/mcp.json` under the
`fluxdown` server's `headers`, and in the FluxDown config as `local_server_token`. Read it from
there — never hardcode or print it.

Relevant key in the `config` table:

| Key | Meaning |
|---|---|
| `default_save_dir` | Global default destination for new tasks |

Resolve order for a new task's directory: **request `saveDir`** → queue `default_save_dir` →
global `default_save_dir`. Passing `saveDir` on the request therefore always wins.

Read it:

```powershell
$h = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "http://127.0.0.1:17800/api/v1/config" -Headers $h | Select default_save_dir
```

Set it (live-applied, no restart, persists in the DB):

```powershell
$body = @{ default_save_dir = 'd:\project\my-music\downloads' } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:17800/api/v1/config" -Headers $h -Method Put -Body $body -ContentType 'application/json'
```

This is a **machine-wide** change: it also affects browser magnet take-over and GUI-added
tasks, not just MCP calls. Prefer passing `saveDir` per request; change the global default
only when the user asks for it.

Useful endpoints:

| Endpoint | Use |
|---|---|
| `GET /api/v1/config` | Read settings |
| `PUT /api/v1/config` | Partial update, key/value strings, live-applied |
| `GET /api/v1/queues` | Queue list and their `defaultSaveDir` |
| `GET /api/v1/tasks` | All tasks |
| `DELETE /api/v1/tasks/{id}` | Remove a task |

OpenAPI document: `GET /api/v1/openapi.json`.

## Why files stay locked

A finished download is still unusable if the downloader holds the file open in a way that
conflicts with how players open it.

- FluxDown opens task files with read **and write** access, sharing only
  `FILE_SHARE_READ | FILE_SHARE_WRITE`.
- foobar2000 opens media files with `FILE_SHARE_READ` (so it can notice files being rewritten).
- The combination fails: Windows returns `ERROR_SHARING_VIOLATION`, and the player reports it
  cannot open the item.

What this looks like when probed:

| Probe | Result |
|---|---|
| `Read` + `FileShare.Read` (player-style) | **fails** — the symptom |
| `Read` + `FileShare.ReadWrite` | succeeds |
| `Write` + `FileShare.ReadWrite` | succeeds |

That asymmetry — readable with a permissive share, writable — is the signature of a writer
holding the file, i.e. the downloader.

Two traps:

1. **Stopping seeding is not enough.** A task with `seedingMessage: "stopped by user"` still
   holds the handle while it remains in the task list.
2. **Reading a locked file needs the permissive share.** Diagnostic scripts must open with
   `FileShare.ReadWrite`, or they will fail for the same reason the player does.

Removing the task from the list releases the handle. Keep the data: `deleteFiles: false`.

## Media library (foobar2000)

The media library here is **foobar2000** via `foo_ai`.

foobar2000 storage, for a scoop portable install:

| Path | Contents |
|---|---|
| `<profile>\config.sqlite` | Settings |
| `<profile>\metadb.sqlite` | Media library index |
| `<profile>\library-v2.0\folders` | Watched directories |
| `<profile>\library-v2.0\content.sqlite` | Library content |
| `<profile>\playlists-v2.0\` | Playlists |

`<profile>` = `C:\Users\PC\scoop\persist\foobar2000\profile` (a junction, so it survives app
updates). `library-v2.0\folders` stores watched dirs as `file://<path>` entries.

Refresh: `foo_ai` has **no** rescan tool, so use `Preferences > Media Library > Rescan` or
restart the player. The library also auto-monitors, so small lags resolve on their own. Never
hand-edit the index.

Read the index through `foo_ai`:

```
list_library(query="ALL", limit=5, fields=["path","artist","title","album"])
```

`Total tracks` in the response is the library's count; compare it against the script's
`AUDIO_COUNT`.

## Extensions counted as audio

`.flac .m4a .mp3 .wav .ape .wv .ogg .opus .aac .dsf .dff .wma .aiff .aif .mpc .tta`

Anything else in the downloads dir (`cover.jpg`, `Music Download.txt`, `.cue`, `.log`) is a
sidecar, not a track, and is expected to stay out of the index.
