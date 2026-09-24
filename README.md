# my-music

> 音乐是人的灵魂，每个人都应可以享受完整的灵魂，而不是 30s。
>
> Music is the soul of a person; everyone deserves to enjoy the whole soul, not just 30 seconds of it.

个人音乐库的本地工具集：通过 MCP（Model Context Protocol）让 AI 助手读取、分析、检索并整理自己的音乐收藏。

A local toolkit for your personal music library: it lets AI assistants read, analyze, search, and organize your own music collection through MCP (Model Context Protocol).

## 项目定位 / Scope

这个仓库不托管、不做种、不向第三方分发任何内容。它只服务**你自己的账号、你自己的音乐库、你自己机器上的 `downloads/` 目录**：

This repository does not host, seed, or distribute anything to third parties. It only serves **your own account, your own library, and the `downloads/` directory on your own machine**:

- 读取歌单、歌曲元数据、歌词 / Read playlists, track metadata, and lyrics
- 分析音乐库（重复歌曲、空歌单、未归类歌曲） / Analyze the library (duplicate tracks, empty playlists, uncategorized songs)
- 检索发布信息（专辑 / 单曲碟的发布名、音质、做种情况） / Search release metadata (release names, quality, swarm health)
- 把**你确认过**的发布下载到 `downloads/` / Download the releases **you confirmed** into `downloads/`
- 生成整理方案，导出本地清单 / Generate an organization plan and export a local manifest

检索结果与下载内容由使用者自行判断与负责；仓库只提供工具，不代替你做判断。

Search results and what you choose to download are your call and your responsibility — the repo provides the tooling, not the judgement.

## 技能 / Skills

| Skill | 用途 / Purpose |
|---|---|
| `music-metadata-search` | 跨 `fleapit`(Nyaa) 与 `torrent-search-mcp` 检索歌手/歌曲/专辑发布信息，产出报告与下载清单（`logs/metadata-search/`） / Search artist/song/album releases across both engines, produce a report plus a download manifest |
| `music-download-pipeline` | 用 FluxDown 把确认过的 URL / 磁力链下到 `downloads/`，解锁文件并同步媒体库 / Stage confirmed URLs or magnets into `downloads/` with FluxDown, unlock files, sync the media library |
| `music-mcp-ops` | 安装、配置、体检各 MCP 服务 / Install, configure, and health-check the MCP services |

## 已接入的 MCP 服务 / Integrated MCP Services

配置见 [`.cursor/mcp.json`](.cursor/mcp.json)。

See [`.cursor/mcp.json`](.cursor/mcp.json) for the configuration.

| 服务 / Service | 类型 / Type | 用途 / Purpose | 说明 / Notes |
|---|---|---|---|
| `qqmusic-mcp` | stdio | QQ 音乐音乐库管理 / QQ Music library management | 读取歌单/歌词、歌单分析、账号级歌单写入（写前有探针保护，支持按 `run_id` 回滚） / Read playlists & lyrics, analyze playlists, account-level playlist writes (probe guard before writing, rollback by `run_id`) |
| `navidrome` | stdio | 本地音乐库检索 / Local library search | 通过 Navidrome 的 Subsonic API 搜索、编排自建音乐库 / Search and organize a self-hosted library via Navidrome's Subsonic API |
| `foo_ai` | SSE | foobar2000 播放控制 / foobar2000 playback control | 播放/暂停、切歌、音量、歌单与媒体库的读写 / Play/pause, track switching, volume, playlist and media library read/write |
| `fleapit` | stdio | Nyaa 发布检索 / Nyaa release search | 音乐资源在 `category: "anime"` 下（Nyaa 的分类如此），结果自带磁力链 / Music lives under `category: "anime"` (Nyaa's own grouping) and results carry magnet links |
| `torrent-search-mcp` | stdio | 多源发布检索 / Multi-source release search | The Pirate Bay / 1337x / Nyaa / uindex 等；返回 Python repr 而非 JSON，磁力链需另调 `get_torrent` / Returns Python reprs rather than JSON; magnets need a separate `get_torrent` call |
| `fluxdown` | HTTP + Bearer | 下载器 / Downloader | 任务落到 `downloads/`，支持 HTTP/FTP URL、磁力链、`.torrent` / Tasks land in `downloads/`; accepts HTTP/FTP URLs, magnets, and `.torrent` files |

### qqmusic-mcp

Windows 专属，通过 `uv` 安装：

Windows-only, installed via `uv`:

```powershell
uv tool install "git+https://github.com/baoozak/qqmusic-mcp.git"
qqmusic-mcp login --force          # 扫码登录，登录态用 Windows DPAPI 加密保存 / QR login; session encrypted with Windows DPAPI
qqmusic-mcp doctor --client cursor # 自检 / self-check
```

用的是 QQ 音乐的非官方接口，上游改版可能导致失效。写操作前会先用临时歌单跑一次探针，探针不过则禁用全部写工具。

It uses QQ Music's unofficial API, so upstream changes may break it. Before any write it runs a probe against a temporary playlist; if the probe fails, all write tools are disabled.

### navidrome

需要一台自行运行的 Navidrome 服务器（默认端口 4533）。首次启动会打开本地设置页填写服务器地址与账号。

Requires a Navidrome server you run yourself (default port 4533). On first launch it opens a local settings page for the server address and credentials.

### foo_ai（foobar2000）

[foo_ai](https://github.com/Bobini1/foo_ai) 是 foobar2000 的原生组件，在播放器进程内起一个 SSE 的 MCP server。要求 foobar2000 **v2.0+**，默认监听 `http://localhost:9910/sse`（端口在 `Preferences > Tools > AI` 可改）。共 19 个工具：媒体库/歌单读写、播放控制、音量。

[foo_ai](https://github.com/Bobini1/foo_ai) is a native foobar2000 component that runs an SSE MCP server inside the player process. It requires foobar2000 **v2.0+** and listens on `http://localhost:9910/sse` by default (the port is configurable under `Preferences > Tools > AI`). It exposes 19 tools: media library / playlist read-write, playback control, and volume.

本机用 scoop 安装的是 **portable 模式**，组件目录有架构区分，容易踩坑：

The local install uses scoop's **portable mode**, where the component directory is architecture-specific — an easy trap:

| 安装形态 / Install form | 用户组件目录 / User component directory |
|---|---|
| 64 位 portable / 64-bit portable | `<安装目录>\profile\user-components-x64\<组件名>\<组件>.dll` |
| 32 位 portable / 32-bit portable | `<安装目录>\profile\user-components\<组件名>\<组件>.dll` |

注意 `.fb2k-component` 包内同时含 32 位（根目录 `foo_ai.dll`）与 64 位（`x64/foo_ai.dll`）两份，**要按播放器架构取对应那份**，否则会因架构不符而静默不加载。第三方组件不要放进 `<安装目录>\components\`（那是官方内置组件的目录）。

Note that the `.fb2k-component` package contains both a 32-bit build (root `foo_ai.dll`) and a 64-bit build (`x64/foo_ai.dll`); **pick the one matching the player's architecture**, or it will silently fail to load. Do not put third-party components in `<install dir>\components\` (that directory is for official built-in components).

scoop 安装的 `profile` 是指向 `scoop\persist\foobar2000\profile` 的 junction，所以组件放在 profile 下可随 scoop 更新保留。

With scoop, `profile` is a junction pointing to `scoop\persist\foobar2000\profile`, so components kept under `profile` survive scoop updates.

验证是否加载成功（两条都要成立）：

To verify it loaded, both checks must pass:

```powershell
# 1. 组件已进入进程模块列表 / the component appears in the process module list
(Get-Process foobar2000).Modules | Where-Object ModuleName -eq 'foo_ai.dll'

# 2. 端口已监听（该组件默认只绑 IPv6 回环 ::1，用 localhost 访问即可） / the port is listening (it binds IPv6 loopback ::1 only, so use localhost)
Get-NetTCPConnection -LocalPort 9910
```

#### 为什么用 mcp-remote 而不是直接写 url / Why use mcp-remote instead of a direct URL

foo_ai 是 **SSE-only** 服务：`GET /sse` 返回 200，`POST /sse` 与 `POST /mcp` 都是 404。而 Cursor 连远程 MCP 时会先发 `POST`，拿到 404 后**不会回退到 SSE**（已知缺陷，`transportType: "sse"` 设置无效）。所以直连配置会一直连不上，必须用 `mcp-remote` 把 SSE 桥接成本地 stdio：

foo_ai is an **SSE-only** server: `GET /sse` returns 200, while both `POST /sse` and `POST /mcp` return 404. But Cursor sends a `POST` first when connecting to a remote MCP server and **does not fall back to SSE** after the 404 (a known bug; `transportType: "sse"` has no effect). So a direct connection never succeeds — you must bridge SSE to local stdio with `mcp-remote`:

```json
{
  "mcpServers": {
    "foo_ai": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "mcp-remote", "http://localhost:9910/sse", "--transport", "sse-only"]
    }
  }
}
```

> 该组件默认只绑定 `::1`，`http://127.0.0.1:9910/sse` 连不上，用 `http://localhost:9910/sse` 或 `http://[::1]:9910/sse` 才通。
>
> The component binds `::1` only, so `http://127.0.0.1:9910/sse` fails; use `http://localhost:9910/sse` or `http://[::1]:9910/sse`.

## 目录结构 / Directory Layout

```
.cursor/mcp.json          MCP 服务配置（已入库；FluxDown token 走环境变量）/ MCP server config (tracked; FluxDown token comes from an env var)
.cursor/skills/           本项目技能（检索、下载流水线、MCP 运维）/ Project skills (search, download pipeline, MCP ops)
logs/                     检索日志与报告（本地生成，已 gitignore）/ Search logs and reports (local, gitignored)
downloads/                下载落点 / Download target directory
authorized_tokens.json    QQ 音乐登录态（本地生成，已 gitignore，不要提交） / QQ Music session (generated locally, gitignored, never commit)
滑雪-*.json / *.csv       歌单导出产物（已 gitignore） / Playlist export artifacts (gitignored)
```

## 导出的数据文件 / Exported Data Files

歌单导出为 JSON，每首歌保留以下字段，便于二次处理或导入：

Playlists are exported as JSON; each track keeps the following fields for further processing or import:

```json
{
  "mid": "002y1ITM32rJq9",
  "song_id": 232670335,
  "name": "歌曲名 / Track name",
  "singers": ["歌手 / Artist"],
  "album": "专辑 / Album",
  "album_mid": "0005m8fw0lj1ge",
  "duration_seconds": 256,
  "sources": ["来源歌单 / Source playlist"]
}
```

`mid` 是 QQ 音乐的歌曲唯一标识，可直接用于跨歌单比对与去重。

`mid` is QQ Music's unique track identifier and can be used directly for cross-playlist comparison and deduplication.

## 安全提示 / Security Notes

- `authorized_tokens.json` 存放登录会话，**不要提交到版本库**，已在 `.gitignore` 中排除。 / `authorized_tokens.json` holds the login session — **do not commit it**; it is excluded in `.gitignore`.
- `.cursor/mcp.json` 已纳入版本管理，但其中 FluxDown 的 Bearer token 用 `${env:FLUXDOWN_TOKEN}` 占位：**本机需设置该环境变量**，否则 FluxDown MCP 连不上。不要把 token 值写回文件。 / `.cursor/mcp.json` is tracked, but the FluxDown bearer token is a `${env:FLUXDOWN_TOKEN}` placeholder — **set that env var locally** or the FluxDown MCP will not connect. Never write the token value back into the file.
- `logs/` 与 `downloads/` 已在 `.gitignore` 中排除（下载的音乐与检索报告都留在本机）。 / `logs/` and `downloads/` are gitignored — downloaded music and search reports stay on your machine.
- 所有凭据仅保存在本机，不经过第三方服务器。 / All credentials stay on your machine and never pass through third-party servers.
- 批量写入自己的歌单属于账号级操作，建议先小批量验证，并保留回滚记录。 / Bulk-writing to your own playlists is an account-level operation; verify with a small batch first and keep rollback records.
- 下载是**逐条确认**的动作，不要从一次检索结果里批量加入全部命中。 / Downloading is a per-item, confirmed action — never bulk-add every hit from a sweep.

## 许可 / License

个人自用项目。

Personal use only.
