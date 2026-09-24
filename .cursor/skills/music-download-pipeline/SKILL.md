---
name: music-download-pipeline
description: >-
  Drive the music download pipeline for this project on Windows: enforce the project
  downloads directory, stage a download from a URL or a magnet link the user supplies (or
  one that the music-metadata-search skill's pick command produced), wait for completion,
  release file locks by cleaning up finished FluxDown tasks, and verify the foobar2000 media
  library stays in sync with disk. Use when the user asks to download music into the project
  downloads folder, when foobar2000 cannot open a freshly downloaded file because another
  process still holds it, when finished download tasks need cleanup so files unlock, or when
  the media library looks stale after new files landed.
disable-model-invocation: true
---

# Music Download Pipeline

Three stages in one pipeline. Each stage is independently useful — you may run only Stage 2 or
Stage 3 if that is all the user needs.

| Stage | Goal |
|---|---|
| 1. Stage | Put a file into `downloads/` without it landing in the wrong folder |
| 2. Unlock | Release the write handle so players can open the file |
| 3. Sync | Keep the media library index aligned with disk |

## Scope and ground rules

- This project manages the user's **own library and its own downloads directory**.
  Stage 1 accepts URLs the user provides, and **magnet links produced by the
  `music-metadata-search` skill's `pick` command** for releases in the user's own
  collection.
- **Searching indexes is a different skill's job.** Do not search from here — use
  `music-metadata-search` (`batch` / `query`, then `pick`) to find releases and
  write a `downloads.json` manifest, then come back to this skill with the
  magnets. Do not hand-roll a search or scrape a page.
- **Never bulk-add a whole sweep.** Add only the releases the user confirmed.
- Never print the FluxDown bearer token. Read it from `.cursor/mcp.json` when a raw API call
  is needed; never echo it into chat or into a file.
- Keep `deleteFiles: false` on every task removal. `true` deletes the user's music.

## Paths

| What | Where |
|---|---|
| Project downloads dir | `d:\project\my-music\downloads` |
| FluxDown MCP server | `fluxdown` (namespace `project-0-my-music-fluxdown`) |
| FluxDown local API | `http://127.0.0.1:17800/api/v1` |
| foobar2000 profile | `C:\Users\PC\scoop\persist\foobar2000\profile` |

## Workflow

Copy this checklist and track progress:

```
- [ ] Stage 1: Confirm target dir, add task, wait for completion
- [ ] Stage 2: Remove finished tasks to release handles
- [ ] Stage 3: Verify disk vs library, rescan if behind
- [ ] Verify: run scripts/verify-downloads.ps1
```

### Stage 1: Stage the download

1. Confirm the target directory before adding anything. The FluxDown default is expected to
   be the project dir; verify rather than assume:

```powershell
$h = @{ Authorization = "Bearer $token" }   # $token read from .cursor/mcp.json
(Invoke-RestMethod -Uri "http://127.0.0.1:17800/api/v1/config" -Headers $h).default_save_dir
```

If it is not `d:\project\my-music\downloads`, pass `saveDir` explicitly on every
`download_add` call — an explicit `saveDir` overrides the queue and global defaults. Fixing
the global default is a machine-wide change; see [reference.md](reference.md#fluxdown-config).

2. Add the task with `download_add`, always passing `saveDir` explicitly so the file cannot
   land elsewhere. `url` accepts an HTTP/HTTPS/FTP URL, a magnet link, or a .torrent URL:

```json
{ "url": "<url or magnet the user confirmed>", "saveDir": "d:\\project\\my-music\\downloads" }
```

3. Poll `download_list` / `download_get` until `status` is `3` (completed). A task that
   reports `errorMessage` mentioning `magnet metadata resolution` never started — report it
   and stop; it has nothing on disk to unlock.

### Stage 2: Unlock finished files

This is the stage that fixes "the player cannot open the file". The root cause is a handle
conflict, not a bad file — see [reference.md](reference.md#why-files-stay-locked).

1. List tasks and collect every task whose `status` is `3` (completed) and whose `saveDir`
   is the project downloads dir.

2. Remove each one **keeping the data on disk**:

```json
{ "taskId": "<id>", "deleteFiles": false }
```

`deleteFiles: false` is mandatory. Passing `true` deletes the user's music.

3. Do not attempt to fix this by stopping seeding. `seedingMessage: "stopped by user"` does
   not release the handle; the task must leave the list.

4. Confirm the handles are gone — see the verification step below. A file is openable by a
   player only when it can be opened with `FileShare.Read`.

### Stage 3: Sync the media library

The media library here is **foobar2000**, not Navidrome (Navidrome is unconfigured and only
exposes setup tools). foobar2000 watches the project downloads dir directly.

1. Compare counts. The library exposes its index through `foo_ai`'s `list_library`; the
   script counts disk files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .cursor/skills/music-download-pipeline/scripts/verify-downloads.ps1
```

2. If `AUDIO_COUNT` on disk exceeds the library `Total tracks`, the index is behind.
   `foo_ai` exposes **no rescan tool** — its 19 tools cover playback and playlist read/write
   only. Trigger a rescan from the player instead:
   `Preferences > Media Library > Rescan`, or restart foobar2000. The library also
   auto-monitors the directory, so a small lag often resolves itself.
3. Never edit `library-v2.0/folders` or the `metadb.sqlite` index by hand. Let the player own
   its database.

## Verification

Run the script and read the summary line by line:

| Field | Expected | Meaning if wrong |
|---|---|---|
| `AUDIO_COUNT` | non-zero | No audio found; check the path |
| `LOCKED_COUNT` | `0` | Handles still held — re-run Stage 2 |
| `OTHER_COUNT` | covers/jpg/txt only | Unexpected non-audio files landed |

Exit code is `1` when any audio file is still locked, `0` otherwise, so it can gate
automation.

Then confirm a real player can open a file: `foo_ai`'s `list_library` returning tracks from
`downloads/` proves both that the index sees them and that they are readable.

## Additional resources

- [reference.md](reference.md) — FluxDown API and config keys, the lock root cause, media
  library locations
- `scripts/verify-downloads.ps1` — disk/lock/layout check (execute it)
