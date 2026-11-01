---
name: music-metadata-search
description: >-
  Search for artist, song, and album release metadata across two MCP engines —
  fleapit (Nyaa, the music index) and torrent-search-mcp (The Pirate Bay, 1337x,
  Nyaa, uindex, and more) — then hand picked releases to the FluxDown download
  pipeline. Covers ad-hoc lookups ("find the album IRIS OUT by 米津玄師"),
  whole-playlist sweeps that report which albums are available for the songs you
  already own, building a reviewable download manifest, and engine health checks.
  Use when the user asks to search for an artist's releases, find a song or album
  on torrent indexes, check which albums in a playlist have releases, download a
  release found by a search, build a search/hit report, or verify the search MCP
  servers are reachable.
---

# Music Metadata Search

Answer "is this artist / song / album out there, and where?" for the user's own
library — then, on request, hand the chosen releases to the project's downloader.
Two search engines, one log bundle per run.

## Scope and ground rules

- **The scripts search and select; downloading is a separate, explicit handoff.**
  `search-metadata.js` never downloads. When the user picks releases, follow
  [Step 6](#step-6-download-handoff): FluxDown `download_add` with an explicit
  `saveDir` into the project downloads dir.
- **Never auto-download out of a sweep.** A batch run can produce hundreds of
  hits; downloading them all is not a decision this skill makes. Present
  candidates, let the user choose, then download.
- **Downloads go through FluxDown, not fleapit.** fleapit has `download_torrent`,
  but it saves to `FLEAPIT_DIR` (default `~/Downloads`, outside this project) and
  **its torrents die when the fleapit MCP server process stops**. FluxDown keeps
  the task in its own queue, lands files in `downloads/`, and has a documented
  unlock + media-library-sync follow-up.
- **Every search run writes a log bundle**, never a file in the project root:
  `logs/metadata-search/<runId>/`. The user's rule is explicit about this.
- **Magnet links are metadata**, and fleapit returns them inline. Do not forward
  them anywhere (`forward_torrent` targets Telegram — out of scope here). Pasting
  a magnet into chat is fine only for the release the user is actually taking.
- Reading `.cursor/mcp.json` for server commands and the FluxDown bearer token is
  expected. Never print a token.

## Engines

| Engine | MCP server | Sources that matter for music | Notes |
|---|---|---|---|
| `fleapit` | `fleapit` (stdio, npm) | **Nyaa only** — `category: "anime"` | Album/single discs with FLAC/Hi-Res. Returns `magnet` inline. ~1-2s per query. |
| `torrent` | `torrent-search-mcp` (stdio, uvx) | thepiratebay.org, 1337x.to, nyaa.si, uindex.org | Best for Western/pop and Chinese releases. Returns **Python reprs, not JSON**, and no magnet. ~20-25s per query. |

Full tool contracts and response shapes: [reference.md](reference.md#engine-tool-contracts).

## Paths

| What | Where |
|---|---|
| Log bundle root | `logs/metadata-search/<runId>/` (gitignored) |
| Driver script | `scripts/search-metadata.js` |
| MCP stdio client | `scripts/mcp-client.js` (reads `.cursor/mcp.json`) |
| Playlist export input | e.g. `滑雪-合并歌单.json` — `{ playlist, songs: [{ mid, name, singers[], album, sources[] }] }` |
| Download target dir | `d:\project\my-music\downloads` |
| FluxDown MCP | namespace `project-0-my-music-fluxdown` |

## Workflow

Copy this checklist and track progress:

```
- [ ] Step 1: Pick the mode (query | batch | sources | pick)
- [ ] Step 2: Check engines are reachable (run `sources` when unsure)
- [ ] Step 3: Run the search
- [ ] Step 4: Read the log bundle, report counts + confidence
- [ ] Step 5: For downloads, run `pick` and confirm the shortlist with the user
- [ ] Step 6: Hand the picked magnets to FluxDown, then unlock + sync
```

### Step 1: Pick the mode

| Mode | Use when | Command |
|---|---|---|
| `query` | The user names an artist / song / album | `query --artist A [--album AL] [--song S]` |
| `batch` | The user wants coverage for a whole playlist export | `batch --input <playlist.json>` |
| `sources` | A run returned nothing, or engines may be down | `sources` |
| `pick` | The user wants to download from an existing run | `pick --run <runId>` |

### Step 2: Check engines

`sources` runs a canary search on each engine and prints per-engine
`rawResults` / `scored` / `strong` plus any `error` or `offline` list. Nyaa
returns results for any real Japanese release; a zero there means the engine is
down, not that the artist is missing.

### Step 3: Run the search

Ad-hoc:

```powershell
node .cursor/skills/music-metadata-search/scripts/search-metadata.js query --artist "米津玄師" --album "IRIS OUT"
```

Whole playlist:

```powershell
node .cursor/skills/music-metadata-search/scripts/search-metadata.js batch --input "滑雪-合并歌单.json"
```

Always **smoke-test a chunk first** (`--max-songs 30`) before a full sweep, and
budget the time honestly:

| Engines | Cost per song | 583-song playlist |
|---|---|---|
| `fleapit` only (batch default) | ~1.2s | ~12 min |
| `fleapit,torrent` with `--torrent-scope fallback` | up to ~25s on misses | 1-2 h+ |

For Western/pop/Chinese material that Nyaa does not carry, add the second engine
deliberately — it is the only way those get results, and it is the slow path:

```powershell
node .cursor/skills/music-metadata-search/scripts/search-metadata.js batch --input "滑雪-合并歌单.json" --engines fleapit,torrent --torrent-scope fallback
```

### Step 4: Read the log bundle

Four files, all under the run directory:

| File | Contents |
|---|---|
| `search.log.jsonl` | One line per request: `run_start`, `phase` events, `engine_error`, `run_end` |
| `hits.json` | Every scored hit with `confidence`, `matched`, `flags`, `magnet`, `seeders` |
| `report.md` | Human-readable grouped report |
| `run.json` | Run metadata and counts (batch only) |

Report **counts plus confidence** to the user, not a raw dump. The headline
numbers are `counts.albumMatchedSongs` / `singleMatchedSongs` / `noMatchSongs`.

### Step 5: Pick the releases to take

`pick` reads a run's `hits.json`, filters candidates, hydrates any missing magnet
through `get_torrent`, and writes `downloads.json` in the same run directory.
Show the shortlist, get a decision, then download.

```powershell
# best 5 by confidence, then seeders, then size
node .cursor/skills/music-metadata-search/scripts/search-metadata.js pick --run "<runId>" --top 5

# specific rows from the report, only healthy swarms
node .cursor/skills/music-metadata-search/scripts/search-metadata.js pick --run "<runId>" --index 1,4 --min-seeders 5

# narrow by title text before choosing
node .cursor/skills/music-metadata-search/scripts/search-metadata.js pick --run "<runId>" --match "FLAC" --top 3
```

Candidate `index` values follow report order, so "the third row under BOOTLEG" is
the same number in `report.md` and in `pick` output. `pick` is read-only apart
from writing the manifest.

### Step 6: Download handoff

For each chosen item, call FluxDown's `download_add` with the magnet and an
explicit `saveDir`:

```json
{ "url": "<magnet from downloads.json>", "saveDir": "d:\\project\\my-music\\downloads" }
```

`download_add` explicitly accepts "an HTTP/HTTPS or FTP URL, **a magnet link**, or
the URL of a .torrent file". Pass `saveDir` every time — without it the task lands
in the global default directory, wherever that is.

Then finish the pipeline — this is the `music-download-pipeline` skill's job, and
its three stages matter here:

1. Poll `download_list` until `status` is `3` (completed).
2. Remove each finished task with `deleteFiles: false` to release the file
   handle, or players cannot open the file. **Never pass `true`** — it deletes
   the user's music.
3. Verify `AUDIO_COUNT` on disk against the foobar2000 library and rescan if the
   index is behind.

Do not add all of a sweep's hits. Confirm the shortlist first, and prefer
seeders > 5 with `confidence: strong`.

## Query construction

The driver builds queries; get this right when searching by hand.

- **Lead artist only.** A release is filed under the lead artist, so
  `["米津玄師 (よねづ けんし)", "菅田将晖"]` queries as `米津玄師`. Joining the
  credit (`米津玄師 / 菅田将晖`) breaks the query — that was a real bug.
- **`<album> <artist>` / `<song> <artist>`**, in that order.
- Drop the parenthesized reading from the query but keep it as a *matching*
  signal: `米津玄師 (よねづ けんし)` queries as `米津玄師`, while `Kenshi Yonezu`
  still counts as a hit inside a release name.
- Strip translation parentheses and version suffixes from song names
  (`打上花火 (烟火绽放)` → `打上花火`, `負けないで ('07 Live Ver.)` → `負けないで`).

## Confidence model

`strong` = the release name hit **both** the artist and the album/song.
`medium` = target only. `weak` = artist only, partial overlap, or a
short-word coincidence.

**Only `strong` is counted** in the report totals and preferred for downloads.
This is deliberate: a bare target word matches unrelated uploads — `BOOTLEG` alone
pulled in "Almost Famous … The Bootleg Cut" and a Bob Dylan bootleg series.
`medium` and `weak` are still written to `hits.json` and shown in report tables,
so nothing is hidden. Details: [reference.md](reference.md#confidence-scoring).

## Critical gotchas

1. **`torrent-search-mcp` returns Python reprs, not JSON.** `structuredContent.result`
   is a *string* like `{'id': '…', 'filename': '…', 'seeders': 5}` — sometimes
   several dicts concatenated with newlines, never a JSON array. `JSON.parse`
   returns nothing useful. The driver's `parsePythonDicts()` handles it; do not
   "fix" it by calling `JSON.parse`.
2. **fleapit only reaches music under `category: "anime"`.** With
   `category: "all"` it returns only tpb-movies / tpb-tv and **zero music**.
   That is Nyaa's category grouping, not a bug — do not switch it.
3. **torrent-search hits have no magnet.** `search_torrents` returns `id`, not a
   magnet; each magnet costs a separate `get_torrent` call. The batch driver
   budgets these with `--magnet-limit` (default 10 per run), and `pick` hydrates
   only the chosen few. fleapit hits already carry theirs.
4. **Do not use fleapit's `download_torrent` for the pipeline.** It saves to
   `FLEAPIT_DIR` (default `~/Downloads`) and its torrents stop when the fleapit
   MCP server process exits. FluxDown keeps the task queued and lands the file in
   `downloads/`.
5. **Removing a finished FluxDown task needs `deleteFiles: false`.** The default
   is not what you want; `true` deletes the music. The file only becomes playable
   once the task leaves the list.
6. **Two short Latin names collide.** Artist `July` + album `Time` matches
   "KEYTALK - Time Square (7 July 2010)". The scorer demotes those to `weak` with
   a `short-signal-coincidence` flag. When reviewing `weak` hits for short English
   names, assume coincidence until the release name proves otherwise.
7. **Album titles with translations are long.** `Greatest Hits 1991-2016 ～All
   Singles + ～` needs token-overlap matching (60% coverage or the longest token),
   not exact-substring. That is already in the scorer; do not tighten it to exact
   match.
8. **A song is skipped at phase 3 only when its album scored a strong hit.** If
   the album query misses, the driver retries per song — so `phase: 3` lines for
   an album you would expect to match mean the album query needs a different
   title spelling, not that phase 3 is broken.
9. **Logs and manifests never go in the project root.** The run directory comes
   from `--out-dir` (default `logs/metadata-search`); changing it to `.`
   re-creates the root-clutter problem the user asked to avoid.

## Verification

- `node scripts/selftest.js` — offline checks for the Python-repr parser,
  normalization, size parsing, candidate flattening, and every confidence rule.
  Run it after touching the scorer. No network needed.
- `node scripts/search-metadata.js sources` — live check that both engines
  connect and return scorable results.

## Reference

- [reference.md](reference.md) — engine tool contracts, response shapes, log and
  manifest schemas, confidence rules, the FluxDown handoff, timing, troubleshooting
- `scripts/search-metadata.js` — the driver (execute it)
- `scripts/mcp-client.js` — stdio MCP client, reads `.cursor/mcp.json`
- `scripts/selftest.js` — offline scorer/parser tests (execute it)
