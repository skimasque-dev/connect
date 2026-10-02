"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const MAX_BYTES = 16 * 1024;

function redact(text, env) {
  for (const name of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "SKIMASQUE_AUTH_TOKEN",
  ]) {
    if (env[name]) text = text.split(env[name]).join("[redacted]");
  }
  return text
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted JWT]");
}

async function reportDiagnostics(manifestPath, options = {}) {
  const write = options.write || console.error;
  const env = options.env || process.env;
  for (const name of ["client", "supervisor"]) {
    let handle;
    try {
      const file = path.join(path.dirname(manifestPath), `${name}.log`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      handle = await fs.open(file, "r");
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - MAX_BYTES));
      const text = redact(buffer.subarray(0, bytesRead).toString("utf8"), env);
      for (const line of text.trimEnd().split(/\r?\n/).slice(-100)) {
        if (line) write(`SkiMasque ${name}: ${line}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        try {
          write(`SkiMasque ${name}: diagnostics unavailable (${error.code || "read error"})`);
        } catch {
          // Reporting must never replace the original Action error.
        }
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  }
}

module.exports = { reportDiagnostics };
