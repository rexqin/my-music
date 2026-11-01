#!/usr/bin/env node
"use strict";

/**
 * Offline self-test for the parsing, normalization, and scoring helpers.
 * Runs without any MCP server, so it is safe as a smoke check after edits.
 *
 *   node scripts/selftest.js
 */

const assert = require("node:assert");
const {
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
  collectCandidates,
} = require("./search-metadata");

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
  }
}

check("parse single python dict", () => {
  const text =
    "{'id': 'abc-20-nyaa.si-1', 'filename': '[20240821] album [FLAC]', 'size': '879.3 MiB', " +
    "'seeders': 5, 'leechers': 0, 'date': '2024-08-20T13:01:06+00:00', 'source': 'nyaa.si'}";
  const dicts = parsePythonDicts(text);
  assert.strictEqual(dicts.length, 1);
  assert.strictEqual(dicts[0].seeders, 5);
  assert.strictEqual(dicts[0].leechers, 0);
  assert.strictEqual(dicts[0].source, "nyaa.si");
  assert.strictEqual(dicts[0].filename, "[20240821] album [FLAC]");
});

check("parse several newline-separated python dicts", () => {
  const text = [
    "{'id': 'a', 'filename': 'first', 'seeders': 1}",
    "{'id': 'b', 'filename': 'second', 'seeders': 2}",
    "{'id': 'c', 'filename': 'third', 'seeders': 3}",
  ].join("\n");
  const dicts = parsePythonDicts(text);
  assert.strictEqual(dicts.length, 3);
  assert.deepStrictEqual(
    dicts.map((dict) => dict.filename),
    ["first", "second", "third"]
  );
});

check("parse python dict holding an apostrophe in a double-quoted string", () => {
  const dicts = parsePythonDicts(`{'id': 'x', 'filename': "B'z - it's a test", 'seeders': 1}`);
  assert.strictEqual(dicts.length, 1);
  assert.strictEqual(dicts[0].filename, "B'z - it's a test");
});

check("parse python list of dicts", () => {
  const dicts = parsePythonDicts("[{'id': 'a', 'seeders': 1}, {'id': 'b', 'seeders': 2}]");
  assert.strictEqual(dicts.length, 2);
});

check("parse empty / non-literal text yields nothing", () => {
  assert.deepStrictEqual(parsePythonDicts(""), []);
  assert.deepStrictEqual(parsePythonDicts("No results found."), []);
});

check("normalizeText folds width, case, and punctuation", () => {
  assert.strictEqual(normalizeText("IRIS OUT／JANE DOE"), "iris out jane doe");
  assert.strictEqual(normalizeText("米津玄師（よねづ けんし）"), "米津玄師 よねづ けんし");
  assert.strictEqual(normalizeText("S.E.N.S."), "s e n s");
});

check("splitArtistName separates the reading alias", () => {
  assert.deepStrictEqual(splitArtistName("米津玄師 (よねづ けんし)"), {
    primary: "米津玄師",
    alias: "よねづ けんし",
  });
  assert.deepStrictEqual(splitArtistName("Sting"), { primary: "Sting", alias: "" });
});

check("buildSignals keeps whole name, primary, alias, and tokens", () => {
  const signals = buildSignals("米津玄師 (よねづ けんし)");
  assert.ok(signals.has("米津玄師"));
  assert.ok(signals.has("よねづ けんし"));
  assert.ok(signals.has("よねづ"));
});

check("parseSizeBytes understands MB and MiB", () => {
  assert.strictEqual(parseSizeBytes("82.20 MB"), Math.round(82.2 * 1024 ** 2));
  assert.strictEqual(parseSizeBytes("879.3 MiB"), Math.round(879.3 * 1024 ** 2));
  assert.strictEqual(parseSizeBytes("1.90 GB"), Math.round(1.9 * 1024 ** 3));
  assert.strictEqual(parseSizeBytes("nonsense"), 0);
});

check("cleanSongName strips translations and version suffixes", () => {
  assert.strictEqual(cleanSongName("打上花火 (烟火绽放)"), "打上花火");
  assert.strictEqual(cleanSongName("打上花火 - Live"), "打上花火");
  assert.strictEqual(cleanSongName("負けないで ('07 Live Ver.)"), "負けないで");
});

check("scoreTitle: artist + target is strong", () => {
  const scored = scoreTitle(
    "[CMEN][2026.03.27] 米津玄師 - IRIS OUT／JANE DOE [Vinyl][96 kHz, 24-bit]",
    { artistSignals: buildSignals("米津玄師 (よねづ けんし)"), targetSignals: buildSignals("IRIS OUT") }
  );
  assert.strictEqual(scored.confidence, "strong");
});

check("scoreTitle: romaji artist alias also counts", () => {
  const scored = scoreTitle("[Nigel] Kenshi Yonezu - IRIS OUT [1440x1080i MPEG2]", {
    artistSignals: buildSignals("米津玄師 (Kenshi Yonezu)"),
    targetSignals: buildSignals("IRIS OUT"),
  });
  assert.strictEqual(scored.confidence, "strong");
});

check("scoreTitle: target only is medium", () => {
  const scored = scoreTitle("[2025.09.24]IRIS OUT／JANE DOE (JANE DOE盤) - Someone Else [FLAC]", {
    artistSignals: buildSignals("米津玄師 (よねづ けんし)"),
    targetSignals: buildSignals("IRIS OUT"),
  });
  assert.strictEqual(scored.confidence, "medium");
});

check("scoreTitle: artist only (discography bundle) is weak", () => {
  const scored = scoreTitle("米津玄師 album discography [FLAC]", {
    artistSignals: buildSignals("米津玄師 (よねづ けんし)"),
    targetSignals: buildSignals("IRIS OUT"),
  });
  assert.strictEqual(scored.confidence, "weak");
});

check("scoreTitle: unrelated release is none", () => {
  const scored = scoreTitle("Spider-Man Brand New Day 2026 1080p WEB-DL", {
    artistSignals: buildSignals("米津玄師 (よねづ けんし)"),
    targetSignals: buildSignals("IRIS OUT"),
  });
  assert.strictEqual(scored.confidence, "none");
});

check("scoreTitle: ascii matching respects word boundaries", () => {
  const scored = scoreTitle("Sometimes I Feel Like a Motherless Child", {
    artistSignals: buildSignals("July"),
    targetSignals: buildSignals("Time"),
  });
  assert.strictEqual(scored.confidence, "none");
});

check("scoreTitle: short ascii target against a CJK artist is still strong but flagged", () => {
  const scored = scoreTitle("米津玄師 - IRIS OUT [FLAC]", {
    artistSignals: buildSignals("米津玄師 (よねづ けんし)"),
    targetSignals: buildSignals("IRIS OUT"),
  });
  assert.strictEqual(scored.confidence, "strong");
  assert.ok(scored.flags.includes("short-target-token"));
});

check("scoreTitle: two short latin signals coinciding are demoted to weak", () => {
  const scored = scoreTitle("KEYTALK - Time Square (7 July 2010)", {
    artistSignals: buildSignals("July (줄라이)"),
    targetSignals: buildSignals("Time"),
  });
  assert.strictEqual(scored.confidence, "weak");
  assert.ok(scored.flags.includes("short-signal-coincidence"));
});

check("scoreTitle: a bare target word shared with unrelated releases stays medium", () => {
  const scored = scoreTitle("Almost Famous 2000 The Bootleg Cut 1080p BluRay", {
    artistSignals: buildSignals("米津玄師 (よねづ けんし)"),
    targetSignals: buildSignals("BOOTLEG"),
  });
  assert.strictEqual(scored.confidence, "medium");
  assert.strictEqual(isCountedHit(scored), false);
  assert.strictEqual(isReportable(scored), true);
});

check("artistKey keeps only the lead artist", () => {
  assert.strictEqual(artistKey(["米津玄師 (よねづ けんし)", "菅田将晖 (すだ まさき)"]), "米津玄師");
  assert.strictEqual(artistKey(["ROSÉ (로제)", "Bruno Mars"]), "ROSÉ");
  assert.strictEqual(artistKey([]), "");
});

check("artistCredit joins the full credit for display", () => {
  assert.strictEqual(artistCredit(["米津玄師 (よねづ けんし)", "菅田将晖 (すだ まさき)"]), "米津玄師 / 菅田将晖");
});

check("artistSignalsFor includes the featured artist as a signal", () => {
  const signals = artistSignalsFor(["米津玄師 (よねづ けんし)", "菅田将晖 (すだ まさき)"]);
  assert.ok(signals.has("米津玄師"));
  assert.ok(signals.has("菅田将晖"));
});

check("scoreTitle: long CJK album title matches on token overlap", () => {
  const scored = scoreTitle(
    "宗次郎 - 背景音乐之旅·恢弘之章 [FLAC]",
    { artistSignals: buildSignals("宗次郎 (そうじろう)"), targetSignals: buildSignals("背景音乐之旅·恢弘之章") }
  );
  assert.strictEqual(scored.confidence, "strong");
});

check("scoreTitle: multi-artist release matches the secondary artist", () => {
  const scored = scoreTitle("米津玄師、宇多田ヒカル - IRIS OUT／JANE DOE [FLAC 48kHz/24bit]", {
    artistSignals: buildSignals("米津玄師 (よねづ けんし)"),
    targetSignals: buildSignals("IRIS OUT"),
  });
  assert.strictEqual(scored.confidence, "strong");
});

check("collectCandidates flattens album groups, targets, and singles in report order", () => {
  const summary = {
    albumGroups: [
      { artist: "A", album: "AL", hits: [{ title: "g1", confidence: "strong", seeders: 1 }] },
    ],
    targets: [{ kind: "album", name: "Q", hits: [{ title: "t1", confidence: "strong", seeders: 2 }] }],
    songs: [{ name: "S", singleHits: [{ title: "s1", confidence: "medium", seeders: 3 }] }],
  };
  const candidates = collectCandidates(summary);
  assert.deepStrictEqual(
    candidates.map((candidate) => candidate.hit.title),
    ["g1", "t1", "s1"]
  );
  assert.strictEqual(candidates[0].scope, "AL — A");
  assert.strictEqual(candidates[1].scope, "album: Q");
  assert.strictEqual(candidates[2].scope, "song: S");
});

check("collectCandidates tolerates a partial export", () => {
  assert.deepStrictEqual(collectCandidates({}), []);
  assert.deepStrictEqual(collectCandidates({ songs: [{ name: "x" }] }), []);
});

check("extractBilingualParts splits outer Latin and inner Chinese", () => {
  const parts = extractBilingualParts("Annie's Wonderland（安妮的仙境）");
  assert.deepStrictEqual(parts.latin, ["Annie's Wonderland"]);
  assert.deepStrictEqual(parts.cjk, ["安妮的仙境"]);
});

check("buildBilingualQueries emits separate zh and en torrent queries", () => {
  const queries = buildBilingualQueries("Annie's Wonderland（安妮的仙境）", "Bandari");
  assert.ok(queries.some((item) => item.lang === "en" && item.query.includes("Annie's Wonderland")));
  assert.ok(queries.some((item) => item.lang === "zh" && item.query.includes("安妮的仙境")));
});

check("buildBilingualQueries keeps a single Latin query for English-only titles", () => {
  const queries = buildBilingualQueries("Every Breath You Take (My Songs Version)", "Sting");
  assert.ok(queries.every((item) => item.lang === "en" || item.lang === "other"));
  assert.ok(queries.some((item) => item.query.includes("Every Breath You Take")));
});

const failed = results.filter((result) => !result.ok);for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok ? "" : `\n      ${result.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
