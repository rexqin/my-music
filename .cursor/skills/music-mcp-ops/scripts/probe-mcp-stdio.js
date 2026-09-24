#!/usr/bin/env node
"use strict";

/**
 * Generic MCP stdio probe.
 *
 * Spawns an MCP stdio server, performs a real handshake (initialize ->
 * notifications/initialized -> tools/list), and reports the result as a single
 * machine-readable line on stdout:
 *
 *   PROBE_RESULT {"ok":true,"toolCount":19,...}
 *
 * The child's own stdout is consumed for protocol parsing and never forwarded,
 * so this script's stdout stays clean and parseable.
 *
 * Usage:
 *   node probe-mcp-stdio.js --timeout 90000 -- npx -y some-mcp-server
 *   PROBE_CMD=... PROBE_ARGS_JSON='["stdio"]' node probe-mcp-stdio.js
 *
 * Exit code: 0 on success, non-zero on failure.
 */

const { spawn } = require("child_process");

const MARKER = "PROBE_RESULT ";
const DEFAULT_TIMEOUT_MS = 90000;
const INIT_DELAY_MS = 2500;
const STDERR_TAIL_CHARS = 1500;

function parseArgv(argv) {
  const result = { timeoutMs: DEFAULT_TIMEOUT_MS, cmd: null, args: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--timeout") {
      const parsed = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(parsed) && parsed > 0) result.timeoutMs = parsed;
      continue;
    }
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    rest.push(token);
  }
  if (rest.length > 0) {
    result.cmd = rest[0];
    result.args = rest.slice(1);
  }
  return result;
}

function parseEnv() {
  const cmd = process.env.PROBE_CMD;
  if (!cmd) return null;
  let args = [];
  const raw = process.env.PROBE_ARGS_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // Accept a bare string too: some serializers unwrap single-element arrays.
      if (Array.isArray(parsed)) args = parsed.map(String);
      else if (typeof parsed === "string") args = [parsed];
    } catch (_) {
      /* fall through with empty args */
    }
  }
  const timeout = Number.parseInt(process.env.PROBE_TIMEOUT_MS || "", 10);
  return {
    cmd,
    args,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

function emit(payload, exitCode) {
  process.stdout.write(MARKER + JSON.stringify(payload) + "\n", () => {
    process.exit(exitCode);
  });
}

function main() {
  const fromEnv = parseEnv();
  const { timeoutMs, cmd, args } = fromEnv || parseArgv(process.argv.slice(2));

  if (!cmd) {
    emit({ ok: false, stage: "config", error: "no command provided" }, 2);
    return;
  }

  const startedAt = Date.now();
  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let stdoutBuffer = "";
  let stderrTail = "";
  let finished = false;
  let messagesSeen = 0;
  let serverInfo = null;
  let protocolVersion = null;

  const finish = (payload, exitCode) => {
    if (finished) return;
    finished = true;
    try {
      child.kill();
    } catch (_) {
      /* already gone */
    }
    payload.durationMs = Date.now() - startedAt;
    if (stderrTail) payload.stderrTail = stderrTail;
    emit(payload, exitCode);
  };

  const send = (message) => {
    if (finished) return;
    try {
      child.stdin.write(JSON.stringify(message) + "\n");
    } catch (_) {
      /* stdin closed */
    }
  };

  const handleMessage = (message) => {
    if (message.method === "notifications/message" || message.method === "log") {
      stderrTail = (stderrTail + JSON.stringify(message)).slice(-STDERR_TAIL_CHARS);
      return;
    }
    messagesSeen += 1;

    if (message.id === 1) {
      if (message.error) {
        finish({ ok: false, stage: "initialize", error: message.error }, 1);
        return;
      }
      serverInfo = (message.result && message.result.serverInfo) || null;
      protocolVersion = (message.result && message.result.protocolVersion) || null;
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      return;
    }

    if (message.id === 2) {
      if (message.error) {
        finish(
          { ok: false, stage: "tools/list", serverInfo, protocolVersion, error: message.error },
          1
        );
        return;
      }
      const rawTools = message.result && message.result.tools;
      const tools = Array.isArray(rawTools) ? rawTools.map((t) => t.name).sort() : [];
      if (tools.length === 0) {
        finish(
          {
            ok: false,
            stage: "tools/list",
            serverInfo,
            protocolVersion,
            error: "server reported zero tools",
          },
          1
        );
        return;
      }
      finish({ ok: true, serverInfo, protocolVersion, toolCount: tools.length, tools }, 0);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line.startsWith("{")) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (_) {
        /* ignore non-JSON noise */
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS * 2);
  });

  child.on("error", (error) => {
    finish({ ok: false, stage: "spawn", error: error.message }, 1);
  });

  child.on("exit", (code) => {
    finish(
      {
        ok: false,
        stage: "exit",
        serverInfo,
        protocolVersion,
        messagesSeen,
        error: "child exited with code " + code,
      },
      1
    );
  });

  setTimeout(() => {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "music-mcp-ops-probe", version: "1.0.0" },
      },
    });
  }, INIT_DELAY_MS);

  setTimeout(() => {
    finish(
      {
        ok: false,
        stage: "timeout",
        serverInfo,
        protocolVersion,
        messagesSeen,
        error: "no tools/list response within " + timeoutMs + "ms",
      },
      1
    );
  }, timeoutMs);
}

main();
