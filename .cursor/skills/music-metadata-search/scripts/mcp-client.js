#!/usr/bin/env node
"use strict";

/**
 * Minimal MCP stdio JSON-RPC client.
 *
 * Server definitions are read from the project's `.cursor/mcp.json` so this
 * never hardcodes a command or a path. The child's stdout is consumed for
 * protocol parsing and never forwarded, so the caller's stdout stays clean.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CALL_TIMEOUT_MS = 120000;
const DEFAULT_START_TIMEOUT_MS = 180000;
const STDERR_TAIL_CHARS = 2000;

function resolveProjectRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  return path.resolve(__dirname, "..", "..", "..", "..");
}

/** Read one stdio server definition out of `.cursor/mcp.json`. */
function readServerConfig(serverName, projectRoot) {
  const configPath = path.join(resolveProjectRoot(projectRoot), ".cursor", "mcp.json");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${configPath}: ${error.message}`);
  }
  const entry = (parsed.mcpServers || {})[serverName];
  if (!entry) {
    const known = Object.keys(parsed.mcpServers || {}).join(", ") || "(none)";
    throw new Error(`server "${serverName}" not found in ${configPath}; known: ${known}`);
  }
  if (!entry.command) {
    throw new Error(
      `server "${serverName}" has no "command" — it is a remote/HTTP server and cannot be spawned over stdio`
    );
  }
  return {
    serverName,
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env: entry.env || {},
    cwd: projectRoot ? resolveProjectRoot(projectRoot) : undefined,
  };
}

class McpStdioClient {
  constructor(options) {
    this.serverName = options.serverName;
    this.command = options.command;
    this.args = options.args || [];
    this.env = options.env || {};
    this.cwd = options.cwd;
    this.startTimeoutMs = options.startTimeoutMs || DEFAULT_START_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs || DEFAULT_CALL_TIMEOUT_MS;
    this.log = options.log || (() => {});
    this.child = null;
    this.buffer = "";
    this.stderrTail = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  static fromMcpJson(serverName, options = {}) {
    const config = readServerConfig(serverName, options.projectRoot);
    return new McpStdioClient({
      ...config,
      serverName,
      startTimeoutMs: options.startTimeoutMs,
      callTimeoutMs: options.callTimeoutMs,
      log: options.log,
    });
  }

  start() {
    if (this.child) return Promise.resolve(this.serverInfo);
    this.child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
    });

    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.on("error", (error) => this.#failAll(new Error(`spawn ${this.command}: ${error.message}`)));
    child.on("exit", (code) => {
      if (!this.closed) {
        this.#failAll(
          new Error(`${this.serverName} exited with code ${code}${this.#stderrSuffix()}`)
        );
      }
    });

    return this.#request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "music-metadata-search", version: "1.0.0" },
    }, this.startTimeoutMs).then((result) => {
      this.serverInfo = (result && result.serverInfo) || { name: this.serverName };
      this.protocolVersion = result && result.protocolVersion;
      this.#notify("notifications/initialized", {});
      return this.serverInfo;
    });
  }

  listTools(options = {}) {
    return this.#request("tools/list", {}, options.timeoutMs || this.callTimeoutMs).then(
      (result) => (result && result.tools) || []
    );
  }

  callTool(name, args = {}, options = {}) {
    return this.#request(
      "tools/call",
      { name, arguments: args },
      options.timeoutMs || this.callTimeoutMs
    ).then((result) => {
      if (!result) throw new Error(`${this.serverName}.${name}: empty result`);
      if (result.isError) {
        throw new Error(`${this.serverName}.${name} failed: ${extractText(result)}`);
      }
      return result;
    });
  }

  /** Call a tool and parse its first text payload as JSON, falling back to raw text. */
  callToolJson(name, args = {}, options = {}) {
    return this.callTool(name, args, options).then((result) => {
      const text = extractText(result);
      const structured = result.structuredContent;
      if (structured !== undefined) return structured;
      try {
        return JSON.parse(text);
      } catch (_) {
        return { text };
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#failAll(new Error(`${this.serverName} client closed`));
    if (this.child) {
      try {
        this.child.kill();
      } catch (_) {
        /* already gone */
      }
      this.child = null;
    }
  }

  #stderrSuffix() {
    return this.stderrTail ? `; stderr: ${this.stderrTail.trim()}` : "";
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line.startsWith("{")) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (_) {
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new Error(`${this.serverName} ${entry.method}: ${JSON.stringify(message.error)}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // Server -> client request: answer so the server never blocks waiting on us.
    if (message.id !== undefined && message.method !== undefined) {
      this.#write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `client does not implement ${message.method}` },
      });
    }
  }

  #write(message) {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify(message) + "\n");
    } catch (_) {
      /* stdin closed */
    }
  }

  #notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  #request(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error(`${this.serverName}: client is closed`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.serverName} ${method}: no response within ${timeoutMs}ms${this.#stderrSuffix()}`
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }
}

function extractText(result) {
  const content = (result && result.content) || [];
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

module.exports = { McpStdioClient, readServerConfig, resolveProjectRoot, extractText };
