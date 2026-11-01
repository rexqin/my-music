# Reference

## Engine tool contracts

Verified live on 2026-09-24 against the servers configured in `.cursor/mcp.json`.

### fleapit (stdio, `npm i -g fleapit`)

Server info: `{"name":"fleapit","version":"0.1.0"}`. Tools:
`search_torrents`, `download_torrent`, `stream_torrent`, `list_files`,
`list_downloads`, `control_torrent`. This skill uses the first only.

`search_torrents` arguments:

| Arg | Type | Notes |
|---|---|---|
| `query` | string | Free text, e.g. `IRIS OUT 米津玄師` |
| `category` | `all` \| `movies` \| `tv` \| `anime` \| `games` | default `all` |
| `limit` | int | default 30 |

Response is real JSON in the text payload:

```json
{
  "query": "IRIS OUT 米津玄師",
  "category": "anime",
  "results": [
    {
      "name": "[CMEN][2026.03.27] 米津玄師 - IRIS OUT／JANE DOE [Vinyl][96 kHz, 24-bit]",
      "size": "480.00 MB",
      "seeders": 12,
      "leechers": 3,
      "source": "nyaa",
      "magnet": "magnet:?xt=urn:btih:76740c86…"
    }
  ]
}
```

Empty result set: `{"query": "…", "category": "anime", "results": [], "note": "No results. …"}`.
A dead source appears as `sourcesOffline: [...]`, not as an error.

**Category matters.** `category: "all"` on a music query returns tpb-movies and
tpb-tv entries and **no music at all**. Nyaa files music under `anime` in this
server's mapping, so music searches must pass `category: "anime"`.

### torrent-search-mcp (stdio, `uvx --from torrent-search-mcp torrent-search-mcp`)

Server info: `{"name":"Torrent Search Tools","version":"4.0.8"}`. Tools:
`available_sources`, `search_torrents`, `popular_torrents`, `get_torrent`,
`authorize_webapp`, `forward_torrent`, `torrent_webapp`. This skill uses
`available_sources`, `search_torrents`, and `get_torrent`.

`available_sources` → `{"result": ["nyaa.si","yts.vg","thepiratebay.org","eztvx.to","fitgirl-repacks.site","subsplease.org","uindex.org","1337x.to"]}`.

`search_torrents` takes **`user_intent`** (a sentence describing the goal) and
**`query`** (optimized keywords), both required. There is no category, no limit,
and no source filter.

The response is **not JSON**. `content[0].text` is one Python dict repr per
result, newline-separated, and `structuredContent.result` is that same string:

```
{'id': '1TbWfQxFKIKT3VdmKLB4SG2BbnIPwvWQbS8dy-20-nyaa.si-9db8b66c3c', 'filename': '[20240821]米津玄師 Kenshi Yonezu 6th Album「LOST CORNER」[FLAC 48kHz 24bit]', 'category': 'Audio - Lossless', 'size': '879.3 MiB', 'seeders': 5, 'leechers': 0, 'downloads': '2219', 'date': '2024-08-20T13:01:06+00:00', 'page_url': 'https://nyaa.si/view/1862329', 'source': 'nyaa.si'}
```

Field mapping used by the driver:

| Python key | Normalized hit field |
|---|---|
| `filename` | `title` |
| `source` | `source` |
| `size` | `size` / `sizeBytes` |
| `seeders` / `leechers` | `seeders` / `leechers` |
| `date` | `date` |
| `page_url` | `pageUrl` |
| `category` | `category` |
| `id` | `torrentId` |
| `downloads` | dropped |

`get_torrent {"torrent_id": "<id>"}` → a bare magnet URI string (no quoting,
no JSON wrapper). This is the only way to get a magnet for these hits.

## Query construction

Implemented in `buildSignals()`, `splitArtistName()`, `artistKey()`,
`cleanSongName()`.

| Input | Signal / query |
|---|---|
| `米津玄師 (よねづ けんし)` | query `米津玄師`; signals `米津玄師`, `よねづ けんし`, `よねづ`, `けんし` |
| `B'z (ビーズ)` | query `B'z`; signals `b z`, `ビーズ` (dots/apostrophes normalize to spaces) |
| `S.E.N.S. (神思者)` | query `S.E.N.S.`; signals `s e n s`, `神思者` |
| `["米津玄師 (よねづ けんし)", "菅田将晖"]` | query uses **`米津玄師`** only; matching signals include the feature |
| song `打上花火 (烟火绽放)` | query target `打上花火` |
| song `負けないで ('07 Live Ver.)` | query target `負けないで` |

Query shapes: artist → `A`; album → `AL A`; song → `S A`.

Normalization (`normalizeText`): NFKC fold, lowercase, then every entry in the
punctuation class (brackets, `～~〜`, `・`, `.`, `-`, `/`, quotes, and the
full-width variants) becomes a space, whitespace collapsed.

## Confidence scoring

`scoreTitle(title, { artistSignals, targetSignals })` → `{ confidence, matched, flags, coverage }`.

| Step | Rule |
|---|---|
| Artist hit | any artist signal appears in the normalized title |
| ASCII signal match | word-boundary regex (`(^\|[^a-z0-9])sig([^a-z0-9]$\|)`), so `time` does not match `sometimes` |
| CJK signal match | substring, per-character tokens generated so short query names still overlap long titles |
| Target hit | longest target token present, **or** ≥60% of target tokens present |
| `strong` | artist hit **and** target hit |
| `medium` | target hit only |
| `weak` | artist hit only, or target overlap below the threshold |
| `none` | neither → dropped |

Flags:

| Flag | Meaning |
|---|---|
| `short-target-token` | longest target token is ASCII and <5 chars (`IRIS OUT` → `iris`). Real hits, but the token is coincidence-prone. |
| `partial-target-overlap` | some target tokens hit but not enough for a target hit |
| `short-signal-coincidence` | **demoted to `weak`**: both the artist and the target longest ASCII tokens are <5 chars |

Counting vs display:

| Helper | Rule | Used for |
|---|---|---|
| `isCountedHit` | `strong` only | headline counts, album-group creation, phase-3 skip |
| `isReportable` | `strong` + `medium` | rows written into `hits.json` and report tables |

Sort order (`compareHits`): confidence rank, then seeders, then size.

## Log bundle schema

`logs/metadata-search/<runId>/`, where `<runId>` is
`YYYYMMDD-HHmmss-<slug>` in UTC.

### `search.log.jsonl`

One JSON object per line. Batch-phase lines mirror the pre-existing
`滑雪-合并歌单-fleapit-搜索日志.jsonl` shape and add `raw` / `scored`.

| Line | Shape |
|---|---|
| run start | `{ ts, event: "run_start", mode, playlist\|artist, songCount, artistCount, albumCount, engines, torrentScope, category }` |
| phase 1 (opt-in) | `{ ts, phase: 1, artist, raw, kept }` |
| phase 2 | `{ ts, phase: 2, artist, album, query, raw, count, scored }` |
| phase 3 | `{ ts, phase: 3, mid, name, query, raw, count, scored }` |
| engine failure | `{ ts, event: "engine_error", engine, query, error }` |
| run end | `{ ts, event: "run_end", durationMs, songs, albumMatchedSongs, … }` |
| pick start | `{ ts, event: "pick_start", runId, filters, candidates, chosen }` |
| pick end | `{ ts, event: "pick_end", durationMs, items, withMagnet }` |

`raw` = hits returned by the engines, `scored` = hits that survived scoring,
`count` = hits counted as `strong`.

### `hits.json`

Query mode:

```
{ runId, mode: "query", artist, album, song, engines, torrentScope, category,
  generatedAt, durationMs, logFile,
  targets: [ { kind, name, query, rawCount, hits: [hit] } ] }
```

Batch mode:

```
{ runId, mode: "batch", playlist, input, engines, torrentScope, category,
  generatedAt, durationMs, logFile, counts, sourceReports, albumGroups, songs }

counts = { songs, albumMatchedSongs, singleMatchedSongs, noMatchSongs, albumGroups }

albumGroups[] = { artist, credit, album, songsInPlaylist, query, hits, coveredSongs }

songs[] = { mid, name, singers, artistPrimary, album, sources, status,
            singleQuery, singleHits, albumHits }   // status: album | single | none
```

A `hit`:

```
{ engine: "fleapit" | "torrent-search", alsoSeenOn?: [engine],
  source, title, size, sizeBytes, seeders, leechers,
  magnet: string|null, torrentId: string|null, date: string|null,
  pageUrl: string|null, category?: string|null,
  confidence: "strong"|"medium"|"weak", matched: [signal], flags: [flag], coverage: number }
```

### `report.md`

Chinese, grouped: header (engines, category, input, log path, duration, counts)
→ `## 一、专辑级命中` → `## 二、单曲级命中` → `## 三、无结果` (first 50) →
`## 四、引擎健康`. Confidence and flags are shown per row.

### `downloads.json` (written by `pick`)

```
{ runId, mode, sourceHitsFile, generatedAt, durationMs,
  filters: { top, indexes, minSeeders, match, includeWeak },
  candidateCount, items: [item] }

item = { index,        // 1-based, matches report row order
         scope,        // "《album》 — artist" or "song: name"
         title, confidence, flags, engine, source,
         size, sizeBytes, seeders, leechers, pageUrl,
         magnet,       // magnet URI, hydrated for torrent-search hits
         torrentId }
```

`candidateCount` is how many hits survived the filters; `items` is the chosen
subset. `index` is stable across `report.md` and repeated `pick` runs on the same
`hits.json`, because it counts candidates in report order.

## Download handoff (FluxDown)

`pick` deliberately stops at a manifest. Downloading is one MCP call per item.

### `download_add`

Verified against the tool schema (2026-09-24): *"Create a download task from an
HTTP/HTTPS or FTP URL, **a magnet link**, or a .torrent URL. Only `url` is
required; every other field overrides a global default for this task alone."*

| Arg | Notes |
|---|---|
| `url` | **required** — the magnet from `downloads.json` |
| `saveDir` | absolute path; empty falls back to the **global** default, so always pass it |
| `queueId` | named queue; empty = default queue |
| `fileName` | empty = inferred from URL / Content-Disposition |
| `startPaused` | `true` creates it paused and waits for a manual start |

Per this project's convention:

```json
{ "url": "<magnet>", "saveDir": "d:\\project\\my-music\\downloads" }
```

### REST equivalent, if a raw call is needed

The same operation over the local API, with the bearer token read from
`.cursor/mcp.json` → `mcpServers.fluxdown.headers.Authorization` (never printed):

| Method + path | Use |
|---|---|
| `POST /api/v1/tasks` | Body `CreateTaskRequest`; only `url` is required. `torrentB64` (base64 .torrent bytes) creates a torrent task instead |
| `GET /api/v1/tasks` | All tasks; poll `status` until `3` (completed) |
| `DELETE /api/v1/tasks/{id}` | Remove a task; keep the data |
| `GET /api/v1/openapi.json` | Full schema (`#/components/schemas/CreateTaskRequest`) |

`CreateTaskRequest` fields worth knowing: `url`, `saveDir`, `queueId`,
`startPaused`, `fileName`, `segments`, `checksum`, `headers`, `proxyUrl`,
`torrentB64`.

### Why not fleapit's `download_torrent`

| | fleapit `download_torrent` | FluxDown `download_add` |
|---|---|---|
| Destination | `FLEAPIT_DIR`, default `~/Downloads` | `saveDir`, set per task |
| Lifetime | torrent lives **inside the fleapit MCP process**; it stops when that process exits | task persists in FluxDown's queue |
| Follow-up | none | `music-download-pipeline` stages: unlock, then media-library sync |

The preferred chain is: `pick` → `download_add` → poll → remove with
`deleteFiles: false` → verify the library. The removal step is not optional;
a finished task still holds the file handle and players will refuse to open it.

## Timing and chunking

Measured on this machine, 2026-09-24, `--delay 150`:

| Engine | Per call |
|---|---|
| fleapit `search_torrents` | ~1-2s |
| torrent-search `search_torrents` | ~20-25s |
| torrent-search `get_torrent` | ~1s |

Queries issued for a batch of N songs (M unique artists, K unique albums,
U songs without an album strong hit): `K + U` (plus `M` when `--artist-probe`
is set). Phase 1 is off by default because it never changes the result set.

Measured runs:

| Run | Wall time |
|---|---|
| 30 songs, fleapit only, no artist probe | 35s |
| 24 songs, fleapit + torrent fallback, artist probe on | 413s |

So the fallback path is what makes a full sweep expensive: a 583-song playlist
is roughly 12 minutes fleapit-only, and hours once torrent-search covers the
misses. Chunk it with `--max-songs`, or run fleapit-only first and target the
misses afterwards.

## Troubleshooting

| Symptom | Cause / action |
|---|---|
| Exit code 1 with `server "x" not found` | The server name changed in `.cursor/mcp.json`; the client reads names `fleapit` and `torrent-search-mcp` |
| Exit code 1 with `no response within …ms` | uvx cold start or a hung server. Re-run `sources`; the uvx first run downloads the package |
| `engine_error` lines in the log, results still present | One engine failed; the other's hits are still scored. Check `available_sources` |
| All-zero `rawResults` on fleapit but torrent-search works | Nyaa is unreachable or the category was changed away from `anime` |
| Report is empty while `hits.json` has rows | The rows were `medium`/`weak`; only `strong` is counted |
| An expected album is missing | Re-run that one album as `query --album` and read the `phase: 2` line — usually the album title spelling differs from the release name |
| CJK looks garbled | Console code page, not the file. `report.md` and `hits.json` are written UTF-8; read them with the editor |
| `--engines fleapit,torrent` is very slow | Expected. Use `--torrent-scope fallback` (default) and `--limit` to bound work |
| `pick` says `--index N out of range` | Indices count filtered candidates in report order; re-run `pick` without `--index` to print the numbered shortlist |
| `pick` output shows `hasMagnet: false` | The hit is a torrent-search result and `get_torrent` failed for it; check the `engine_error` line in the run log, or re-run `pick` |
| `download_add` returns 400 | `url` is required and must be a URL / magnet / .torrent URL; check the magnet was not truncated when copied |
| Downloaded file will not open in the player | The FluxDown task is still in the list holding the handle — remove it with `deleteFiles: false` |
| Files landed somewhere unexpected | `saveDir` was omitted and the global default applied. Pass it on every task |

## Environment notes

- Node ≥ 20 (the repo machine runs v24.21.0). Scripts are CommonJS and use only
  `node:` built-ins.
- The driver spawns MCP servers exactly as `.cursor/mcp.json` declares them,
  including the `cmd /c` wrapper, so Windows `.cmd` shims work.
- `--project-root <path>` overrides the repo root used both for
  `.cursor/mcp.json` and for resolving `--out-dir`.
