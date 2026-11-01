#!/usr/bin/env node
"use strict";

/**
 * Metadata search driver for the user's own music library.
 *
 * Searches two MCP engines — `fleapit` (Nyaa, best for music releases) and
 * `torrent-search-mcp` (broad multi-source index) — and writes every run as a
 * log bundle under `logs/metadata-search/<runId>/`.
 *
 * This script only *searches* and *selects*; it never downloads. Downloading is
 * an explicit, user-confirmed handoff to the project's FluxDown pipeline (see
 * SKILL.md), driven by the `downloads.json` manifest that `pick` writes.
 *
 * Usage:
 *   node scripts/search-metadata.js sources
 *   node scripts/search-metadata.js query --artist "米津玄師" [--album "IRIS OUT"] [--song "Lemon"]
 *   node scripts/search-metadata.js batch --input <playlist.json> [--playlist "name"]
 *   node scripts/search-metadata.js pick --run <runId> [--top 5] [--index 1,4]
 *
 * Options:
 *   --engines fleapit,torrent   Engines to use (default: query=both, batch=fleapit)
 *   --torrent-scope SCOPE       `always` queries both engines every time,
 *                               `fallback` only when the primary engine found no
 *                               strong hit, `never` skips torrent-search entirely
 *                               (default: query=always, batch=fallback)
 *   --category anime            fleapit source category (default: anime → Nyaa)
 *   --limit 30                  Max results kept per fleapit query
 *   --out-dir logs/metadata-search
 *   --delay 250                 Milliseconds between MCP calls
 *   --torrent-limit 12          Max torrent-search hits kept per query
 *   --magnet-limit 10           Torrent-search magnet lookups per run (each is a
 *                               separate call; fleapit hits already carry magnets)
 *   --max-songs N               Only process the first N songs (smoke tests)
 *   --bilingual                 Split album/song names into Chinese vs Latin
 *                               segments and query torrent-search separately
 *                               for each (implies --engines torrent --torrent-scope always)
 *   --artist-probe              Also probe every artist (diagnostic, one extra
 *                               query per artist; off by default)
 *   --no-report                 Skip report.md
 *   --verbose                   Print progress to stderr (default: quiet)
 *
 * pick options:
 *   --run <runId|path>          Required. Run id under the out dir, or a path
 *   --top N                     Take the best N candidates (default 5)
 *   --index 1,4                 Take these 1-based candidates instead of --top
 *   --min-seeders 5             Drop candidates below this seeder count
 *   --match "text"              Keep only titles containing this text
 *   --include-weak              Also consider weak-confidence hits
 *   --out downloads.json        Manifest file name inside the run directory
 */

const fs = require("node:fs");
const path = require("node:path");
const { McpStdioClient, resolveProjectRoot } = require("./mcp-client");

const FOLLOWUP_TOOLS = new Set(["search_torrents", "available_sources", "get_torrent", "list_library"]);
const FORBIDDEN_TOOL_PATTERN = /download|stream|control/i;

const DEFAULTS = {
  engines: null,
  torrentScope: null,
  category: "anime",
  limit: 30,
  torrentLimit: 12,
  magnetLimit: 10,
  delayMs: 250,
  outDir: "logs/metadata-search",
  maxSongs: 0,
  report: true,
  verbose: false,
  artistProbe: false,
  bilingual: false,
};

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;
const LATIN_RE = /[a-zA-Z]/;

/**
 * Per-command defaults. `query` is a handful of lookups, so it can afford both
 * engines every time. `batch` walks a whole playlist, where torrent-search costs
 * ~20-25s per call against fleapit's ~1-2s, so it starts fleapit-only and
 * falls back to torrent-search only on a miss.
 */
const COMMAND_DEFAULTS = {
  query: { engines: ["fleapit", "torrent"], torrentScope: "always" },
  batch: { engines: ["fleapit"], torrentScope: "fallback" },
  sources: { engines: ["fleapit", "torrent"], torrentScope: "always" },
  pick: { engines: ["fleapit"], torrentScope: "never" },
};

// ---------------------------------------------------------------------------
// Python-literal parsing (torrent-search-mcp returns Python reprs, not JSON)
// ---------------------------------------------------------------------------

/**
 * Parse the Python literal subset that torrent-search-mcp emits: dicts, lists,
 * single/double quoted strings, numbers, True/False/None. Returns every
 * top-level dict found in the text, so it works for one dict, several
 * newline-separated dicts, or a list of dicts.
 */
function parsePythonDicts(text) {
  const parser = new PyLiteralParser(text);
  const found = [];
  for (;;) {
    const index = parser.findNextContainer();
    if (index < 0) break;
    try {
      const value = parser.parseAt(index);
      collectDicts(value, found);
      parser.position = parser.position || index;
    } catch (_) {
      parser.position = index + 1;
    }
  }
  return found;
}

function collectDicts(value, sink) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectDicts(item, sink));
  } else if (value && typeof value === "object") {
    sink.push(value);
  }
}

class PyLiteralParser {
  constructor(text) {
    this.text = text;
    this.position = 0;
  }

  findNextContainer() {
    for (let i = this.position; i < this.text.length; i++) {
      const ch = this.text[i];
      if (ch === "{" || ch === "[") return i;
    }
    return -1;
  }

  parseAt(index) {
    this.position = index;
    const value = this.#parseValue();
    return value;
  }

  #parseValue() {
    this.#skipWhitespace();
    const ch = this.text[this.position];
    if (ch === "{") return this.#parseDict();
    if (ch === "[") return this.#parseList();
    if (ch === "(") return this.#parseList(")");
    if (ch === "'" || ch === '"') return this.#parseString();
    return this.#parseScalar();
  }

  #parseDict() {
    const result = {};
    this.position++; // {
    for (;;) {
      this.#skipWhitespace();
      if (this.text[this.position] === "}") {
        this.position++;
        return result;
      }
      if (this.position >= this.text.length) return result;
      const key = this.#parseValue();
      this.#skipWhitespace();
      if (this.text[this.position] === ":") this.position++;
      const value = this.#parseValue();
      if (key !== undefined && key !== null) result[String(key)] = value;
      this.#skipWhitespace();
      if (this.text[this.position] === ",") this.position++;
    }
  }

  #parseList(closer = "]") {
    const result = [];
    this.position++; // [ or (
    for (;;) {
      this.#skipWhitespace();
      if (this.text[this.position] === closer) {
        this.position++;
        return result;
      }
      if (this.position >= this.text.length) return result;
      result.push(this.#parseValue());
      this.#skipWhitespace();
      if (this.text[this.position] === ",") this.position++;
    }
  }

  #parseString() {
    const quote = this.text[this.position];
    const triple = this.text.startsWith(quote.repeat(3), this.position);
    this.position += triple ? 3 : 1;
    let out = "";
    while (this.position < this.text.length) {
      const ch = this.text[this.position];
      if (ch === "\\") {
        const next = this.text[this.position + 1];
        out += decodeEscape(next);
        this.position += 2;
        continue;
      }
      if (triple ? this.text.startsWith(quote.repeat(3), this.position) : ch === quote) {
        this.position += triple ? 3 : 1;
        return out;
      }
      out += ch;
      this.position++;
    }
    return out;
  }

  #parseScalar() {
    const match = /^(True|False|None|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z0-9_.]*)/.exec(
      this.text.slice(this.position)
    );
    if (!match) {
      this.position++;
      return undefined;
    }
    this.position += match[0].length;
    const token = match[0];
    if (token === "True") return true;
    if (token === "False") return false;
    if (token === "None") return null;
    if (/^-?\d/.test(token)) return Number(token);
    return token;
  }

  #skipWhitespace() {
    while (this.position < this.text.length && /\s/.test(this.text[this.position])) this.position++;
  }
}

function decodeEscape(char) {
  switch (char) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "\\":
      return "\\";
    case "'":
      return "'";
    case '"':
      return '"';
    default:
      return char === undefined ? "" : char;
  }
}

// ---------------------------------------------------------------------------
// Text normalization and confidence scoring
// ---------------------------------------------------------------------------

const PUNCTUATION = /[「」『』【】〔〕（）()[\]{}［］〈〉《》〈〉、。，．.・…～~〜＋+\-—–_/\\|:：;；!！?？"“”'’‘`*&＃#@$%^,]/g;

function normalizeText(value) {
  if (!value) return "";
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized) {
  if (!normalized) return [];
  return normalized
    .split(" ")
    .flatMap((chunk) => {
      if (/^[a-z0-9]+$/.test(chunk)) return [chunk];
      // Split CJK runs into single characters as well, so a shorter query name
      // still overlaps a longer release title.
      const chars = chunk.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g);
      return chars ? [chunk, ...chars] : [chunk];
    })
    .filter((token) => token.length >= 1);
}

/** Split "米津玄師 (よねづ けんし)" into primary name and parenthesized alias. */
function splitArtistName(fullName) {
  const text = String(fullName || "").trim();
  const match = /^(.*?)\s*[（(]([^）)]*)[）)]\s*$/.exec(text);
  if (match && match[1].trim()) {
    return { primary: match[1].trim(), alias: match[2].trim() };
  }
  return { primary: text, alias: "" };
}

function buildSignals(name) {
  const signals = new Set();
  const raw = String(name || "").trim();
  if (!raw) return signals;
  const { primary, alias } = splitArtistName(raw);
  const whole = normalizeText(raw);
  if (whole) signals.add(whole);
  for (const part of [primary, alias]) {
    const normalized = normalizeText(part);
    if (!normalized) continue;
    signals.add(normalized);
    for (const token of normalized.split(" ")) {
      if (token.length >= (isAscii(token) ? 3 : 1)) signals.add(token);
    }
  }
  return signals;
}

function isAscii(value) {
  return /^[\x20-\x7e]+$/.test(value);
}

function signalHits(normalizedTitle, signal) {
  if (!signal) return false;
  if (isAscii(signal)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(signal)}([^a-z0-9]|$)`);
    return pattern.test(normalizedTitle);
  }
  return normalizedTitle.includes(signal);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score a release title against the artist and target (album or song) signals.
 * strong = target + artist, medium = target only, weak = artist only or a
 * partial target-token overlap. `none` means it is noise and gets dropped.
 */
function scoreTitle(title, { artistSignals, targetSignals }) {
  const normalized = normalizeText(title);
  const matched = [];
  let artistHit = false;
  for (const signal of artistSignals) {
    if (signalHits(normalized, signal)) {
      artistHit = true;
      matched.push(signal);
    }
  }

  const targetTokens = new Set();
  for (const signal of targetSignals) {
    for (const token of tokenize(signal)) targetTokens.add(token);
  }
  const tokens = [...targetTokens].sort((a, b) => b.length - a.length);
  let targetTokenHits = 0;
  let longestTokenHit = false;
  for (const token of tokens) {
    if (signalHits(normalized, token)) {
      targetTokenHits++;
      matched.push(token);
      if (token === tokens[0]) longestTokenHit = true;
    }
  }
  const coverage = tokens.length === 0 ? 0 : targetTokenHits / tokens.length;
  const targetHit = tokens.length > 0 && (longestTokenHit || coverage >= 0.6);

  const flags = [];
  const longestTarget = tokens[0] || "";
  if (targetHit && isAscii(longestTarget) && longestTarget.length < 5) {
    flags.push("short-target-token");
  }
  if (artistHit && !targetHit && tokens.length > 0 && targetTokenHits > 0) {
    flags.push("partial-target-overlap");
  }

  // Two short Latin words coinciding (e.g. artist "July" + album "Time" hitting
  // "KEYTALK - Time Square (7 July 2010)") is almost always an accident, not a
  // release. CJK or longer signals do not have this failure mode.
  const longestArtist = longestAsciiSignal(artistSignals);
  if (
    artistHit &&
    targetHit &&
    longestArtist &&
    longestArtist.length < 5 &&
    isAscii(longestTarget) &&
    longestTarget.length < 5
  ) {
    flags.push("short-signal-coincidence");
    return { confidence: "weak", matched: [...new Set(matched)], flags, coverage: Number(coverage.toFixed(2)) };
  }

  let confidence = "none";
  if (artistHit && targetHit) confidence = "strong";
  else if (targetHit) confidence = "medium";
  else if (artistHit) confidence = "weak";
  else if (targetTokenHits > 0) confidence = "weak";

  return { confidence, matched: [...new Set(matched)], flags, coverage: Number(coverage.toFixed(2)) };
}

/** Longest ASCII token among a signal set, or "" when none is ASCII. */
function longestAsciiSignal(signals) {
  let longest = "";
  for (const signal of signals || []) {
    for (const token of String(signal).split(" ")) {
      if (isAscii(token) && token.length > longest.length) longest = token;
    }
  }
  return longest;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

class EngineError extends Error {}

class CallQueue {
  constructor(delayMs) {
    this.delayMs = delayMs;
    this.tail = Promise.resolve();
  }

  run(task) {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => sleep(this.delayMs),
      () => sleep(this.delayMs)
    );
    return result;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guardTool(toolName) {
  if (FORBIDDEN_TOOL_PATTERN.test(toolName) && !FOLLOWUP_TOOLS.has(toolName)) {
    throw new EngineError(`refusing to call "${toolName}": this skill is search-only`);
  }
}

function makeFleapitEngine(client, options) {
  const queue = new CallQueue(options.delayMs);
  return {
    name: "fleapit",
    async search(query) {
      guardTool("search_torrents");
      const raw = await queue.run(() =>
        client.callToolJson("search_torrents", {
          query,
          category: options.category,
          limit: options.limit,
        })
      );
      const results = Array.isArray(raw.results) ? raw.results : [];
      return {
        note: raw.note || null,
        offline: raw.sourcesOffline || null,
        hits: results.map((item) => ({
          engine: "fleapit",
          source: item.source || "nyaa",
          title: item.name || "(untitled)",
          size: item.size || "",
          sizeBytes: parseSizeBytes(item.size),
          seeders: Number(item.seeders) || 0,
          leechers: Number(item.leechers) || 0,
          magnet: item.magnet || null,
          torrentId: null,
          date: null,
          pageUrl: null,
        })),
      };
    },
  };
}

function makeTorrentEngine(client, options, hydrator) {
  const queue = new CallQueue(options.delayMs);
  return {
    name: "torrent-search",
    async search(query, userIntent) {
      guardTool("search_torrents");
      const result = await queue.run(() =>
        client.callTool("search_torrents", { query, user_intent: userIntent })
      );
      const text = firstText(result);
      const dicts = parsePythonDicts(text).slice(0, options.torrentLimit);
      const hits = dicts.map((item) => ({
        engine: "torrent-search",
        source: item.source || "",
        title: item.filename || "(untitled)",
        size: item.size || "",
        sizeBytes: parseSizeBytes(item.size),
        seeders: Number(item.seeders) || 0,
        leechers: Number(item.leechers) || 0,
        magnet: null,
        torrentId: item.id || null,
        date: item.date || null,
        pageUrl: item.page_url || null,
        category: item.category || null,
      }));
      return { note: null, offline: null, hits, hydrator };
    },
  };
}

function firstText(result) {
  const content = (result && result.content) || [];
  for (const item of content) {
    if (item && item.type === "text" && typeof item.text === "string") return item.text;
  }
  const structured = result && result.structuredContent;
  if (structured && typeof structured.result === "string") return structured.result;
  return "";
}

function parseSizeBytes(size) {
  const match = /([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)/i.exec(String(size || ""));
  if (!match) return 0;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const scale = {
    b: 1,
    kb: 1024,
    kib: 1024,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  return Number.isFinite(value) ? Math.round(value * (scale[unit] || 1)) : 0;
}

/** Query the enabled engines, score every hit, and merge duplicates by title. */
async function runSearch(engines, { query, userIntent, artistSignals, targetSignals, options, logger }) {
  const perEngine = [];
  for (const engine of engines) {
    try {
      const response = await engine.search(query, userIntent);
      perEngine.push({ engine: engine.name, ...response });
    } catch (error) {
      logger.event({ event: "engine_error", engine: engine.name, query, error: error.message });
      perEngine.push({ engine: engine.name, hits: [], error: error.message });
    }
  }

  const merged = new Map();
  for (const response of perEngine) {
    for (const hit of response.hits) {
      const scored = scoreTitle(hit.title, { artistSignals, targetSignals });
      if (scored.confidence === "none") continue;
      const key = normalizeText(hit.title);
      const existing = merged.get(key);
      const annotated = { ...hit, ...scored };
      if (!existing) {
        merged.set(key, annotated);
        continue;
      }
      existing.seeders = Math.max(existing.seeders, annotated.seeders);
      if (!existing.magnet && annotated.magnet) existing.magnet = annotated.magnet;
      if (!existing.torrentId && annotated.torrentId) existing.torrentId = annotated.torrentId;
      if (annotated.engine !== existing.engine) {
        existing.alsoSeenOn = [...new Set([...(existing.alsoSeenOn || []), annotated.engine])];
      }
    }
  }

  const hits = [...merged.values()].sort(compareHits);
  return {
    hits,
    rawCount: perEngine.reduce((sum, response) => sum + response.hits.length, 0),
    engines: perEngine.map((response) => ({
      engine: response.engine,
      hits: response.hits.length,
      error: response.error || null,
      note: response.note || null,
      offline: response.offline || null,
    })),
  };
}

const CONFIDENCE_RANK = { strong: 0, medium: 1, weak: 2 };

function compareHits(a, b) {
  const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (byConfidence !== 0) return byConfidence;
  if (b.seeders !== a.seeders) return b.seeders - a.seeders;
  return b.sizeBytes - a.sizeBytes;
}

/**
 * Counted as a real match: the release title had to hit BOTH the artist and the
 * album/song. Target-only (`medium`) hits are shown in reports but never counted,
 * because a bare word like "bootleg" otherwise matches unrelated uploads.
 */
function isCountedHit(hit) {
  return hit.confidence === "strong";
}

/** Worth showing in a report: strong or medium. */
function isReportable(hit) {
  return hit.confidence === "strong" || hit.confidence === "medium";
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

class RunLogger {
  constructor(directory, runId) {
    this.directory = directory;
    this.runId = runId;
    this.jsonlPath = path.join(directory, "search.log.jsonl");
    this.lines = [];
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(this.jsonlPath, "", "utf8");
  }

  event(payload) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...payload });
    this.lines.push(line);
    fs.appendFileSync(this.jsonlPath, line + "\n", "utf8");
  }

  writeJson(fileName, value) {
    const target = path.join(this.directory, fileName);
    fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf8");
    return target;
  }

  writeText(fileName, value) {
    const target = path.join(this.directory, fileName);
    fs.writeFileSync(target, value, "utf8");
    return target;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function withEngines(options, work) {
  const projectRoot = options.projectRoot;
  const log = options.verbose ? (message) => process.stderr.write(`[metadata-search] ${message}\n`) : () => {};
  const clients = [];
  const engines = [];
  let torrentHydrator = null;

  try {
    if (options.engines.includes("fleapit")) {
      const client = McpStdioClient.fromMcpJson("fleapit", {
        projectRoot,
        callTimeoutMs: options.callTimeoutMs,
      });
      await client.start();
      log(`fleapit ready (${client.serverInfo && client.serverInfo.name})`);
      clients.push(client);
      engines.push(makeFleapitEngine(client, options));
    }
    if (options.engines.includes("torrent")) {
      const client = McpStdioClient.fromMcpJson("torrent-search-mcp", {
        projectRoot,
        callTimeoutMs: options.callTimeoutMs,
      });
      await client.start();
      log(`torrent-search-mcp ready (${client.serverInfo && client.serverInfo.name})`);
      clients.push(client);
      const queue = new CallQueue(options.delayMs);
      torrentHydrator = async (torrentId) => {
        guardTool("get_torrent");
        const result = await queue.run(() => client.callTool("get_torrent", { torrent_id: torrentId }));
        const text = firstText(result).trim();
        return /^magnet:/i.test(text) ? text : null;
      };
      engines.push(makeTorrentEngine(client, options, torrentHydrator));
    }
    if (engines.length === 0) throw new Error("no engines enabled");
    const budget = { remaining: Math.max(0, options.magnetLimit) };
    return await work({ engines, log, torrentHydrator, budget });
  } finally {
    clients.forEach((client) => client.close());
  }
}

async function commandSources(options) {
  return withEngines(options, async ({ engines, log }) => {
    const report = [];
    for (const engine of engines) {
      const probe = await runSearch([engine], {
        query: "ZARD",
        userIntent: "check whether the music source is reachable",
        artistSignals: buildSignals("ZARD"),
        targetSignals: buildSignals("ZARD Forever Best"),
        options,
        logger: { event: () => {} },
      });
      const entry = {
        engine: engine.name,
        rawResults: probe.rawCount,
        scored: probe.hits.length,
        strong: probe.hits.filter((hit) => hit.confidence === "strong").length,
        error: probe.engines[0] && probe.engines[0].error,
        offline: probe.engines[0] && probe.engines[0].offline,
      };
      report.push(entry);
      log(JSON.stringify(entry));
    }
    console.log(JSON.stringify({ engines: report }, null, 2));
    return report;
  });
}

async function commandQuery(options) {
  const runId = makeRunId(options.playlistName || "query");
  const directory = path.join(resolveProjectRoot(options.projectRoot), options.outDir, runId);
  const logger = new RunLogger(directory, runId);

  const targets = [];
  if (options.album) targets.push({ kind: "album", name: options.album });
  if (options.song) targets.push({ kind: "song", name: options.song });
  if (targets.length === 0) targets.push({ kind: "artist", name: options.artist });

  const artistSignals = buildSignals(options.artist);
  const startedAt = Date.now();
  logger.event({
    event: "run_start",
    mode: "query",
    artist: options.artist,
    album: options.album || null,
    song: options.song || null,
    engines: options.engines,
    torrentScope: options.torrentScope,
    category: options.category,
  });

  const results = [];
  await withEngines(options, async ({ engines, log, torrentHydrator, budget }) => {
    for (const target of targets) {
      const targetSignals = target.kind === "artist" ? buildSignals("") : buildSignals(target.name);
      const query = buildQuery(target, options.artist);
      const request = {
        query,
        userIntent: `find ${target.kind} "${target.name}" by ${options.artist}`,
        artistSignals: target.kind === "artist" ? buildSignals(options.artist) : artistSignals,
        targetSignals,
        options,
        logger,
      };
      let searched = await runSearch(primaryEngines(engines, options), request);
      if (!searched.hits.some(isCountedHit) && shouldFallback(engines, options)) {
        const retry = await runSearch(torrentEngines(engines), request);
        if (retry.rawCount > 0) searched = retry;
      }
      const hits = searched.hits;
      const shown = hits.filter(isReportable);
      await hydrateMagnets(shown, torrentHydrator, options, budget);
      const counted = hits.filter(isCountedHit).length;
      logger.event({
        phase: target.kind,
        artist: options.artist,
        target: target.name,
        query,
        raw: searched.rawCount,
        count: counted,
        scored: hits.length,
      });
      log(`"${query}" → ${counted} hit(s)`);
      results.push({ ...target, query, rawCount: searched.rawCount, hits });
    }
    return null;
  });

  const summary = {
    runId,
    mode: "query",
    artist: options.artist,
    album: options.album || null,
    song: options.song || null,
    engines: options.engines,
    torrentScope: options.torrentScope,
    category: options.category,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    logFile: path.relative(process.cwd(), logger.jsonlPath),
    targets: results,
  };
  const hitsPath = logger.writeJson("hits.json", summary);
  logger.event({ event: "run_end", durationMs: summary.durationMs, hits: results.reduce((sum, t) => sum + t.hits.filter(isCountedHit).length, 0) });
  if (options.report) {
    logger.writeText("report.md", renderQueryReport(summary));
  }
  console.log(JSON.stringify({ runId, directory, logFile: logger.jsonlPath, hitsFile: hitsPath, targets: results.map((t) => ({ kind: t.kind, name: t.name, raw: t.rawCount, hits: t.hits.filter(isCountedHit).length, scored: t.hits.length })) }, null, 2));
  return summary;
}

async function hydrateMagnets(hits, hydrator, options, budget) {
  if (!hydrator || !budget || budget.remaining <= 0) return;
  for (const hit of hits) {
    if (budget.remaining <= 0) return;
    if (hit.magnet || !hit.torrentId) continue;
    try {
      hit.magnet = await hydrator(hit.torrentId);
      budget.remaining--;
    } catch (_) {
      /* magnet is optional; leave it null */
    }
  }
}

/** Engines to hit first: fleapit holds the music index, so it goes alone unless `always`. */
function primaryEngines(engines, options) {
  if (options.torrentScope === "always") return engines;
  const fleapit = engines.filter((engine) => engine.name === "fleapit");
  return fleapit.length > 0 ? fleapit : engines;
}

function torrentEngines(engines) {
  return engines.filter((engine) => engine.name === "torrent-search");
}

function shouldFallback(engines, options) {
  return options.torrentScope === "fallback" && torrentEngines(engines).length > 0;
}

function buildQuery(target, artist) {
  if (target.kind === "artist") return artist;
  return `${target.name} ${artist}`.trim();
}

function cleanSongName(name) {
  return String(name || "")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/['’]\d{2}\s*(live|ver\.?)?/gi, " ")
    .replace(/\s*[-–—]\s*(live|ver\.?|remaster(ed)?|acoustic|instrumental)\b.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scriptOf(text) {
  const value = String(text || "").trim();
  if (!value) return "empty";
  const hasCjk = CJK_RE.test(value);
  const hasLatin = LATIN_RE.test(value);
  if (hasCjk && hasLatin) return "mixed";
  if (hasCjk) return "cjk";
  if (hasLatin) return "latin";
  return "other";
}

/** Split a title into CJK vs Latin segments (outer text + parenthetical parts). */
function extractBilingualParts(text) {
  const raw = String(text || "").trim();
  if (!raw) return { cjk: [], latin: [], other: [] };

  const segments = [];
  const parenRe = /[（(]([^）)]*)[）)]/g;
  let match;
  while ((match = parenRe.exec(raw)) !== null) {
    const inner = match[1].trim();
    if (inner) segments.push(inner);
  }
  const outer = raw.replace(/[（(][^）)]*[）)]/g, " ").replace(/\s+/g, " ").trim();
  if (outer) segments.unshift(outer);

  const cjk = [];
  const latin = [];
  const other = [];
  const seen = new Set();
  for (const segment of segments) {
    const key = normalizeText(segment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const script = scriptOf(segment);
    if (script === "cjk" || script === "mixed") cjk.push(segment);
    if (script === "latin" || script === "mixed") latin.push(segment);
    if (script === "other") other.push(segment);
  }

  if (cjk.length === 0 && latin.length === 0 && other.length === 0) {
    const script = scriptOf(raw);
    if (script === "latin") latin.push(raw);
    else if (script === "cjk" || script === "mixed") cjk.push(raw);
    else other.push(raw);
  }
  return { cjk, latin, other };
}

/**
 * Build separate torrent queries for Chinese vs Latin name parts.
 * Chinese queries pair CJK title segments with CJK artist segments when available.
 */
function buildBilingualQueries(namePart, artistPart) {
  const target = extractBilingualParts(namePart);
  const artist = extractBilingualParts(artistPart || "");
  const queries = [];
  const seen = new Set();
  const artistRaw = String(artistPart || "").trim();

  function push(lang, name, artistName) {
    const query = `${name} ${artistName}`.trim();
    const key = normalizeText(query);
    if (!query || seen.has(key)) return;
    seen.add(key);
    queries.push({ query, lang, namePart: name, artistPart: artistName });
  }

  const cjkArtists = artist.cjk.length ? artist.cjk : artistRaw ? [artistRaw] : [""];
  const latinArtists = artist.latin.length ? artist.latin : artistRaw ? [artistRaw] : [""];

  for (const name of target.cjk) {
    for (const artistName of cjkArtists) push("zh", name, artistName);
  }
  for (const name of target.latin) {
    for (const artistName of latinArtists) push("en", name, artistName);
  }
  for (const name of target.other) {
    push("other", name, artistRaw);
  }
  if (queries.length === 0 && namePart) {
    push("any", String(namePart).trim(), artistRaw);
  }
  return queries;
}

/** Run one query per bilingual variant and merge scored hits. */
async function runBilingualSearch(
  engines,
  { namePart, artistPart, userIntentPrefix, artistSignals, targetSignals, options, logger }
) {
  const variants = buildBilingualQueries(namePart, artistPart);
  const merged = new Map();
  let rawCount = 0;
  const queryLog = [];

  for (const variant of variants) {
    const searched = await runSearch(engines, {
      query: variant.query,
      userIntent: `${userIntentPrefix} [${variant.lang}] ${variant.query}`,
      artistSignals,
      targetSignals,
      options,
      logger,
    });
    rawCount += searched.rawCount;
    queryLog.push({
      ...variant,
      raw: searched.rawCount,
      kept: searched.hits.length,
      counted: searched.hits.filter(isCountedHit).length,
    });
    for (const hit of searched.hits) {
      const key = normalizeText(hit.title);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...hit, matchedQuery: variant.query, matchedLang: variant.lang });
        continue;
      }
      existing.seeders = Math.max(existing.seeders, hit.seeders);
      if (!existing.magnet && hit.magnet) existing.magnet = hit.magnet;
      if (!existing.torrentId && hit.torrentId) existing.torrentId = hit.torrentId;
      if (compareHits(hit, existing) < 0) {
        existing.matchedQuery = variant.query;
        existing.matchedLang = variant.lang;
      }
    }
  }

  return {
    hits: [...merged.values()].sort(compareHits),
    rawCount,
    queries: queryLog,
  };
}

/**
 * Lead artist — the one that goes into the query. A release is filed under the
 * lead artist, so "米津玄師 / 菅田将晖" must query as "米津玄師"; the guest singer
 * only matters as a matching signal.
 */
function artistKey(singers) {
  const list = (Array.isArray(singers) ? singers : [singers]).filter(Boolean);
  if (list.length === 0) return "";
  return splitArtistName(list[0]).primary;
}

/** Display credit for all singers, joined for the report. */
function artistCredit(singers) {
  const list = (Array.isArray(singers) ? singers : [singers]).filter(Boolean);
  return list.map((name) => splitArtistName(name).primary).join(" / ");
}

/** Matching signals from every credited singer, so a feature still counts. */
function artistSignalsFor(singers) {
  const list = (Array.isArray(singers) ? singers : [singers]).filter(Boolean);
  const signals = new Set();
  for (const name of list) {
    for (const signal of buildSignals(name)) signals.add(signal);
  }
  return signals;
}

function albumKey(artistPrimary, album) {
  return `${artistPrimary}|||${album}`;
}

async function commandBatch(options) {
  const inputPath = path.resolve(options.input);
  const loaded = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const playlistName = options.playlistName || (loaded.playlist && loaded.playlist.name) || path.basename(inputPath);
  let songs = Array.isArray(loaded.songs) ? loaded.songs : [];
  if (options.maxSongs > 0) songs = songs.slice(0, options.maxSongs);
  if (songs.length === 0) throw new Error(`no songs found in ${inputPath}`);

  const runId = makeRunId(playlistName);
  const directory = path.join(resolveProjectRoot(options.projectRoot), options.outDir, runId);
  const logger = new RunLogger(directory, runId);
  const startedAt = Date.now();

  const artists = new Map();
  const albums = new Map();
  for (const song of songs) {
    const primary = artistKey(song.singers);
    if (!primary) continue;
    if (!artists.has(primary)) {
      artists.set(primary, { artist: primary, credit: artistCredit(song.singers), songs: 0, signals: artistSignalsFor(song.singers) });
    }
    artists.get(primary).songs++;
    const album = String(song.album || "").trim();
    if (!album) continue;
    const key = albumKey(primary, album);
    if (!albums.has(key)) {
      albums.set(key, {
        artist: primary,
        credit: artistCredit(song.singers),
        album,
        songs: 0,
        artistSignals: artistSignalsFor(song.singers),
      });
    }
    albums.get(key).songs++;
  }

  logger.event({
    event: "run_start",
    mode: options.bilingual ? "batch-bilingual" : "batch",
    playlist: playlistName,
    input: path.relative(process.cwd(), inputPath),
    songCount: songs.length,
    artistCount: artists.size,
    albumCount: albums.size,
    engines: options.engines,
    torrentScope: options.torrentScope,
    category: options.category,
    bilingual: Boolean(options.bilingual),
  });

  const albumHitsByKey = new Map();
  const songResults = [];
  const sourceNotes = [];

  await withEngines(options, async ({ engines, log, torrentHydrator, budget }) => {
    log(`${songs.length} songs / ${artists.size} artists / ${albums.size} albums`);

    // Phase 1 is a diagnostic only: it costs one query per artist and never
    // changes the result set, so it is opt-in.
    if (options.artistProbe) {
      for (const entry of artists.values()) {
        const searched = await runSearch(engines, {
          query: entry.artist,
          userIntent: `check availability for artist ${entry.artist}`,
          artistSignals: entry.signals,
          targetSignals: new Set(),
          options,
          logger,
        });
        logger.event({ phase: 1, artist: entry.artist, raw: searched.rawCount, kept: searched.hits.length });
        sourceNotes.push(...searched.engines.map((item) => ({ artist: entry.artist, ...item })));
      }
    }

    const albumList = [...albums.values()];
    const torrentOnly = torrentEngines(engines);
    for (const entry of albumList) {
      const key = albumKey(entry.artist, entry.album);
      let scored;
      let rawCount;
      let queryLog = null;
      if (options.bilingual) {
        const searched = await runBilingualSearch(torrentOnly, {
          namePart: entry.album,
          artistPart: entry.artist,
          userIntentPrefix: `find album "${entry.album}" by ${entry.artist}`,
          artistSignals: entry.artistSignals,
          targetSignals: buildSignals(entry.album),
          options,
          logger,
        });
        scored = searched.hits;
        rawCount = searched.rawCount;
        queryLog = searched.queries;
      } else {
        const query = `${entry.album} ${entry.artist}`.trim();
        const request = {
          query,
          userIntent: `find album "${entry.album}" by ${entry.artist}`,
          artistSignals: entry.artistSignals,
          targetSignals: buildSignals(entry.album),
          options,
          logger,
        };
        let searched = await runSearch(primaryEngines(engines, options), request);
        if (!searched.hits.some(isCountedHit) && shouldFallback(engines, options)) {
          const retry = await runSearch(torrentOnly, request);
          if (retry.rawCount > 0) searched = retry;
        }
        scored = searched.hits;
        rawCount = searched.rawCount;
        queryLog = [{ query, lang: "combined", raw: rawCount, kept: scored.length, counted: scored.filter(isCountedHit).length }];
      }
      const shown = scored.filter(isReportable);
      await hydrateMagnets(shown, torrentHydrator, options, budget);
      albumHitsByKey.set(key, scored);
      const counted = scored.filter(isCountedHit).length;
      logger.event({
        phase: 2,
        artist: entry.artist,
        album: entry.album,
        queries: queryLog,
        raw: rawCount,
        count: counted,
        scored: scored.length,
      });
      if (counted > 0) log(`album hit: ${entry.album} — ${entry.artist} (${counted})`);
    }

    for (const song of songs) {
      const primary = artistKey(song.singers);
      const album = String(song.album || "").trim();
      const albumHits = album ? albumHitsByKey.get(albumKey(primary, album)) || [] : [];
      if (albumHits.some(isCountedHit)) {
        songResults.push(
          buildSongResult(song, primary, "album", null, [], albumHits.filter(isReportable))
        );
        continue;
      }
      let scored;
      let rawCount;
      let queryLog;
      let primaryQuery;
      if (options.bilingual) {
        const searched = await runBilingualSearch(torrentOnly, {
          namePart: song.name,
          artistPart: primary,
          userIntentPrefix: `find song "${song.name}" by ${primary}`,
          artistSignals: artistSignalsFor(song.singers),
          targetSignals: buildSignals(song.name),
          options,
          logger,
        });
        scored = searched.hits;
        rawCount = searched.rawCount;
        queryLog = searched.queries;
        primaryQuery = queryLog.map((item) => item.query).join(" | ");
      } else {
        const songName = cleanSongName(song.name);
        primaryQuery = `${songName} ${primary}`.trim();
        const request = {
          query: primaryQuery,
          userIntent: `find song "${songName}" by ${primary}`,
          artistSignals: artistSignalsFor(song.singers),
          targetSignals: buildSignals(songName),
          options,
          logger,
        };
        let searched = await runSearch(primaryEngines(engines, options), request);
        if (!searched.hits.some(isCountedHit) && shouldFallback(engines, options)) {
          const retry = await runSearch(torrentOnly, request);
          if (retry.rawCount > 0) searched = retry;
        }
        scored = searched.hits;
        rawCount = searched.rawCount;
        queryLog = [{ query: primaryQuery, lang: "combined", raw: rawCount, kept: scored.length, counted: scored.filter(isCountedHit).length }];
      }
      const shown = scored.filter(isReportable);
      await hydrateMagnets(shown, torrentHydrator, options, budget);
      const counted = scored.filter(isCountedHit).length;
      logger.event({
        phase: 3,
        mid: song.mid,
        name: song.name,
        queries: queryLog,
        raw: rawCount,
        count: counted,
        scored: scored.length,
      });
      songResults.push(buildSongResult(song, primary, counted > 0 ? "single" : "none", primaryQuery, shown, []));
    }
    return null;
  });

  const albumGroups = [];
  for (const entry of albums.values()) {
    const scored = albumHitsByKey.get(albumKey(entry.artist, entry.album)) || [];
    if (!scored.some(isCountedHit)) continue;
    albumGroups.push({
      artist: entry.artist,
      credit: entry.credit,
      album: entry.album,
      songsInPlaylist: entry.songs,
      query: `${entry.album} ${entry.artist}`.trim(),
      hits: scored.filter(isReportable),
      coveredSongs: songs
        .filter((song) => artistKey(song.singers) === entry.artist && String(song.album || "").trim() === entry.album)
        .map((song) => song.name),
    });
  }
  albumGroups.sort((a, b) => b.coveredSongs.length - a.coveredSongs.length);

  const counts = {
    songs: songResults.length,
    albumMatchedSongs: songResults.filter((item) => item.status === "album").length,
    singleMatchedSongs: songResults.filter((item) => item.status === "single").length,
    noMatchSongs: songResults.filter((item) => item.status === "none").length,
    albumGroups: albumGroups.length,
  };

  const summary = {
    runId,
    mode: options.bilingual ? "batch-bilingual" : "batch",
    playlist: playlistName,
    input: path.relative(process.cwd(), inputPath),
    engines: options.engines,
    torrentScope: options.torrentScope,
    category: options.category,
    bilingual: Boolean(options.bilingual),
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    logFile: path.relative(process.cwd(), logger.jsonlPath),
    counts,
    sourceReports: sourceNotes,
    albumGroups,
    songs: songResults,
  };
  const hitsPath = logger.writeJson("hits.json", summary);
  logger.writeJson("run.json", {
    runId,
    mode: summary.mode,
    playlist: playlistName,
    input: summary.input,
    engines: options.engines,
    torrentScope: options.torrentScope,
    category: options.category,
    bilingual: summary.bilingual,
    generatedAt: summary.generatedAt,
    durationMs: summary.durationMs,
    counts,
    logFile: summary.logFile,
    hitsFile: path.relative(process.cwd(), hitsPath),
  });
  logger.event({ event: "run_end", durationMs: summary.durationMs, ...counts });
  if (options.report) logger.writeText("report.md", renderBatchReport(summary));

  console.log(JSON.stringify({ runId, directory, logFile: logger.jsonlPath, hitsFile: hitsPath, counts }, null, 2));
  return summary;
}

function buildSongResult(song, primary, status, singleQuery, singleHits, albumHits) {
  return {
    mid: song.mid,
    name: song.name,
    singers: song.singers,
    artistPrimary: primary,
    album: song.album || "",
    sources: song.sources || [],
    status,
    singleQuery: singleQuery || null,
    singleHits,
    albumHits,
  };
}

function makeRunId(label) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const slug = String(label || "run")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug ? `${stamp}-${slug}` : stamp;
}

// ---------------------------------------------------------------------------
// pick: turn report hits into a reviewable download manifest
// ---------------------------------------------------------------------------

/** Flatten a run's hits.json into a stable, report-ordered candidate list. */
function collectCandidates(summary) {
  const candidates = [];
  const push = (hit, scope) => candidates.push({ hit, scope });
  if (Array.isArray(summary.albumGroups)) {
    for (const group of summary.albumGroups) {
      for (const hit of group.hits || []) push(hit, `${group.album} — ${group.artist}`);
    }
  }
  for (const target of summary.targets || []) {
    for (const hit of target.hits || []) push(hit, `${target.kind}: ${target.name}`);
  }
  for (const song of summary.songs || []) {
    for (const hit of song.singleHits || []) push(hit, `song: ${song.name}`);
  }
  return candidates;
}

async function commandPick(options) {
  if (!options.run) throw new Error("pick requires --run <runId>");
  const root = resolveProjectRoot(options.projectRoot);
  const runDir = path.isAbsolute(options.run)
    ? options.run
    : path.join(root, options.outDir, options.run);
  const hitsPath = path.join(runDir, "hits.json");
  if (!fs.existsSync(hitsPath)) {
    throw new Error(`no hits.json in ${runDir} — pass --run with a run id under ${options.outDir}`);
  }
  const summary = JSON.parse(fs.readFileSync(hitsPath, "utf8"));

  const confidences = options.includeWeak ? new Set(["strong", "medium", "weak"]) : new Set(["strong", "medium"]);
  const match = options.match ? normalizeText(options.match) : null;
  const all = collectCandidates(summary)
    .map((candidate, position) => ({ ...candidate, position: position + 1 }))
    .filter((candidate) => confidences.has(candidate.hit.confidence))
    .filter((candidate) => candidate.hit.seeders >= options.minSeeders)
    .filter((candidate) => !match || normalizeText(candidate.hit.title).includes(match));

  let chosen;
  if (options.indexes && options.indexes.length > 0) {
    const byPosition = new Map(all.map((candidate) => [candidate.position, candidate]));
    const missing = options.indexes.filter((index) => !byPosition.has(index));
    if (missing.length > 0) {
      throw new Error(
        `--index ${missing.join(",")} out of range; candidates are 1..${all.length}`
      );
    }
    chosen = options.indexes.map((index) => byPosition.get(index));
  } else {
    chosen = [...all]
      .sort((a, b) => compareHits(a.hit, b.hit))
      .slice(0, options.top);
  }

  const logger = new RunLogger(runDir, path.basename(runDir));
  const startedAt = Date.now();
  logger.event({
    event: "pick_start",
    runId: summary.runId || path.basename(runDir),
    filters: {
      top: options.indexes && options.indexes.length > 0 ? null : options.top,
      indexes: options.indexes || null,
      minSeeders: options.minSeeders,
      match: options.match || null,
      includeWeak: options.includeWeak,
    },
    candidates: all.length,
    chosen: chosen.length,
  });

  // torrent-search hits carry no magnet; hydrate the chosen few only.
  const needsHydration = chosen.some((candidate) => !candidate.hit.magnet && candidate.hit.torrentId);
  const items = chosen.map((candidate) => ({
    index: candidate.position,
    scope: candidate.scope,
    title: candidate.hit.title,
    confidence: candidate.hit.confidence,
    flags: candidate.hit.flags || [],
    engine: candidate.hit.engine,
    source: candidate.hit.source,
    size: candidate.hit.size,
    sizeBytes: candidate.hit.sizeBytes,
    seeders: candidate.hit.seeders,
    leechers: candidate.hit.leechers,
    pageUrl: candidate.hit.pageUrl || null,
    magnet: candidate.hit.magnet || null,
    torrentId: candidate.hit.torrentId || null,
  }));

  if (needsHydration) {
    const client = McpStdioClient.fromMcpJson("torrent-search-mcp", {
      projectRoot: options.projectRoot,
      callTimeoutMs: options.callTimeoutMs,
    });
    try {
      await client.start();
      for (const item of items) {
        if (item.magnet || !item.torrentId) continue;
        guardTool("get_torrent");
        try {
          const result = await client.callTool("get_torrent", { torrent_id: item.torrentId });
          const text = firstText(result).trim();
          if (/^magnet:/i.test(text)) item.magnet = text;
        } catch (error) {
          logger.event({
            event: "engine_error",
            engine: "torrent-search",
            query: item.title,
            error: error.message,
          });
        }
      }
    } finally {
      client.close();
    }
  }

  const manifest = {
    runId: summary.runId || path.basename(runDir),
    mode: summary.mode || "unknown",
    sourceHitsFile: path.relative(process.cwd(), hitsPath),
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    filters: {
      top: options.indexes && options.indexes.length > 0 ? null : options.top,
      indexes: options.indexes || null,
      minSeeders: options.minSeeders,
      match: options.match || null,
      includeWeak: options.includeWeak,
    },
    candidateCount: all.length,
    items,
  };
  const manifestPath = logger.writeJson(options.out, manifest);
  const hittable = items.filter((item) => item.magnet).length;
  logger.event({ event: "pick_end", durationMs: manifest.durationMs, items: items.length, withMagnet: hittable });

  console.log(
    JSON.stringify(
      {
        runId: manifest.runId,
        manifestFile: manifestPath,
        candidateCount: all.length,
        chosen: items.map((item) => ({
          index: item.index,
          title: item.title,
          size: item.size,
          seeders: item.seeders,
          confidence: item.confidence,
          hasMagnet: Boolean(item.magnet),
        })),
      },
      null,
      2
    )
  );
  return manifest;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function renderHitTable(hits) {
  const lines = ["| 置信 | 来源 | 引擎 | 发布名 | 大小 | S/L |", "|---|---|---|---|---|---|"];
  for (const hit of hits) {
    const title = String(hit.title).replace(/\|/g, "\\|");
    const engines = [hit.engine, ...(hit.alsoSeenOn || [])].filter(Boolean).join("+");
    lines.push(
      `| ${hit.confidence}${hit.flags && hit.flags.length ? ` (${hit.flags.join(",")})` : ""} | ${hit.source || "-"} | ${engines} | ${title} | ${hit.size || "-"} | ${hit.seeders}/${hit.leechers} |`
    );
  }
  return lines.join("\n");
}

function renderEngineLine(summary) {
  const engines = summary.engines.join(", ");
  if (!summary.engines.includes("torrent")) return `- 引擎：${engines}`;
  return `- 引擎：${engines}（torrent-search 范围：${summary.torrentScope}）`;
}

function renderBatchReport(summary) {
  const lines = [];
  lines.push(`# 元信息检索报告：${summary.playlist}`);
  lines.push("");
  lines.push(`- 生成时间：${summary.generatedAt}`);
  lines.push(renderEngineLine(summary));
  lines.push(`- fleapit 类别：\`${summary.category}\`（音乐资源只在 Nyaa，故用 anime）`);
  lines.push(`- 输入：\`${summary.input}\``);
  lines.push(`- 日志：\`${summary.logFile}\``);
  lines.push(`- 耗时：${(summary.durationMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push(
    `- 结果：**专辑级命中 ${summary.counts.albumMatchedSongs} 首**（${summary.counts.albumGroups} 张专辑）、单曲级命中 ${summary.counts.singleMatchedSongs} 首、无结果 ${summary.counts.noMatchSongs} 首`
  );
  lines.push("");
  lines.push("> 口径：Nyaa 上音乐以**专辑 / 单曲碟**为单位发布，先按「歌手 + 专辑」检索，命中的种子天然覆盖该专辑下歌单里的全部歌曲。");
  lines.push("> 计入口径最严：发布名必须**同时命中歌手与专辑/歌曲名**（`strong`）才算命中；`medium`（只命中专辑/歌曲名）与 `weak` 只作展示，不计入统计。");
  lines.push("> `medium` / `weak` 建议人工确认，短英文名（如 Time / July）更易出现一词巧合。");
  lines.push("");
  lines.push(`## 一、专辑级命中（${summary.counts.albumGroups} 张专辑，覆盖 ${summary.counts.albumMatchedSongs} 首）`);
  lines.push("");
  for (const group of summary.albumGroups) {
    lines.push(`### ${group.album} — ${group.artist}（歌单内 ${group.songsInPlaylist} 首）`);
    lines.push("");
    lines.push(`检索式：\`${group.query}\``);
    lines.push("");
    lines.push(renderHitTable(group.hits));
    lines.push("");
    if (group.coveredSongs.length) {
      lines.push(`覆盖曲目：${group.coveredSongs.join("、")}`);
      lines.push("");
    }
  }

  const singles = summary.songs.filter((song) => song.status === "single");
  lines.push(`## 二、单曲级命中（${singles.length} 首）`);
  lines.push("");
  for (const song of singles) {
    lines.push(`### ${song.name} — ${song.artistPrimary}（专辑：${song.album || "-"}）`);
    lines.push("");
    lines.push(`检索式：\`${song.singleQuery}\``);
    lines.push("");
    lines.push(renderHitTable(song.singleHits));
    lines.push("");
  }

  const missing = summary.songs.filter((song) => song.status === "none");
  lines.push(`## 三、无结果（${missing.length} 首）`);
  lines.push("");
  lines.push("前 50 条：");
  lines.push("");
  for (const song of missing.slice(0, 50)) {
    lines.push(`- ${song.name} — ${song.artistPrimary}${song.album ? `（专辑：${song.album}）` : ""}`);
  }
  lines.push("");
  lines.push("## 四、引擎健康");
  lines.push("");
  const problem = summary.sourceReports.filter((item) => item.error || (item.offline && item.offline.length));
  if (problem.length === 0) {
    lines.push("本次运行未记录引擎错误。");
  } else {
    for (const item of problem.slice(0, 20)) {
      lines.push(`- ${item.artist} / ${item.engine}：error=${item.error || "-"} offline=${(item.offline || []).join(",") || "-"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderQueryReport(summary) {
  const lines = [];
  lines.push(`# 元信息检索：${summary.artist}`);
  lines.push("");
  lines.push(`- 生成时间：${summary.generatedAt}`);
  lines.push(renderEngineLine(summary));
  lines.push(`- 日志：\`${summary.logFile}\``);
  lines.push("");
  for (const target of summary.targets) {
    lines.push(`## ${target.kind}：${target.name}`);
    lines.push("");
    lines.push(`检索式：\`${target.query}\``);
    lines.push("");
    lines.push(target.hits.length ? renderHitTable(target.hits) : "无命中。");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    command: argv[0] && !argv[0].startsWith("--") ? argv[0] : "query",
    engines: DEFAULTS.engines,
    torrentScope: DEFAULTS.torrentScope,
    category: DEFAULTS.category,
    limit: DEFAULTS.limit,
    torrentLimit: DEFAULTS.torrentLimit,
    magnetLimit: DEFAULTS.magnetLimit,
    delayMs: DEFAULTS.delayMs,
    outDir: DEFAULTS.outDir,
    maxSongs: DEFAULTS.maxSongs,
    report: DEFAULTS.report,
    verbose: DEFAULTS.verbose,
    artistProbe: DEFAULTS.artistProbe,
    bilingual: DEFAULTS.bilingual,
    run: null,
    top: 5,
    indexes: null,
    minSeeders: 0,
    match: null,
    includeWeak: false,
    out: "downloads.json",
    callTimeoutMs: 180000,
    artist: null,
    album: null,
    song: null,
    input: null,
    playlistName: null,
    projectRoot: null,
  };
  const start = options.command === "query" && (!argv[0] || argv[0].startsWith("--")) ? 0 : 1;
  for (let i = start; i < argv.length; i++) {
    const token = argv[i];
    const next = () => argv[++i];
    switch (token) {
      case "--engines":
        options.engines = String(next()).split(",").map((value) => value.trim()).filter(Boolean);
        break;
      case "--torrent-scope":
        options.torrentScope = next();
        break;
      case "--category":
        options.category = next();
        break;
      case "--limit":
        options.limit = Number(next());
        break;
      case "--torrent-limit":
        options.torrentLimit = Number(next());
        break;
      case "--magnet-limit":
        options.magnetLimit = Number(next());
        break;
      case "--delay":
        options.delayMs = Number(next());
        break;
      case "--out-dir":
        options.outDir = next();
        break;
      case "--input":
        options.input = next();
        break;
      case "--playlist":
        options.playlistName = next();
        break;
      case "--project-root":
        options.projectRoot = next();
        break;
      case "--timeout":
        options.callTimeoutMs = Number(next());
        break;
      case "--max-songs":
        options.maxSongs = Number(next());
        break;
      case "--artist":
        options.artist = next();
        break;
      case "--album":
        options.album = next();
        break;
      case "--song":
        options.song = next();
        break;
      case "--no-report":
        options.report = false;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--artist-probe":
        options.artistProbe = true;
        break;
      case "--bilingual":
        options.bilingual = true;
        break;
      case "--run":
        options.run = next();
        break;
      case "--top":
        options.top = Number(next());
        break;
      case "--index":
        options.indexes = String(next())
          .split(",")
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isFinite(value));
        break;
      case "--min-seeders":
        options.minSeeders = Number(next());
        break;
      case "--match":
        options.match = next();
        break;
      case "--include-weak":
        options.includeWeak = true;
        break;
      case "--out":
        options.out = next();
        break;
      default:
        throw new Error(`unknown option: ${token}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const defaults = COMMAND_DEFAULTS[options.command];
  if (!defaults) {
    throw new Error(`unknown command: ${options.command} (expected sources | query | batch | pick)`);
  }
  if (!options.engines) options.engines = defaults.engines;
  if (!options.torrentScope) options.torrentScope = defaults.torrentScope;
  if (options.bilingual) {
    options.engines = ["torrent"];
    options.torrentScope = "always";
  }
  const unknown = options.engines.filter((name) => name !== "fleapit" && name !== "torrent");
  if (unknown.length > 0) {
    throw new Error(`unknown engine(s): ${unknown.join(", ")} (expected fleapit, torrent)`);
  }
  switch (options.command) {
    case "sources":
      return commandSources(options);
    case "query":
      if (!options.artist) throw new Error("query requires --artist");
      return commandQuery(options);
    case "batch":
      if (!options.input) throw new Error("batch requires --input");
      return commandBatch(options);
    case "pick":
      return commandPick(options);
    default:
      throw new Error(`unknown command: ${options.command} (expected sources | query | batch | pick)`);
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`[metadata-search] FAILED: ${error && error.message ? error.message : error}`);
      process.exit(1);
    });
}

module.exports = {
  parsePythonDicts,
  normalizeText,
  buildSignals,
  scoreTitle,
  parseSizeBytes,
  cleanSongName,
  scriptOf,
  extractBilingualParts,
  buildBilingualQueries,
  splitArtistName,
  artistKey,
  artistCredit,
  artistSignalsFor,
  isCountedHit,
  isReportable,
  compareHits,
  collectCandidates,
};
