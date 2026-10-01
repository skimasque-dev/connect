"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { run } = require("./command.cjs");
function targetFor(platform, arch) {
  const target = {
    "linux/x64": "x86_64-unknown-linux-gnu",
    "linux/arm64": "aarch64-unknown-linux-gnu",
    "darwin/arm64": "aarch64-apple-darwin",
    "win32/x64": "x86_64-pc-windows-msvc",
  }[`${platform}/${arch}`];
  if (!target)
    throw new Error(
      `No client release for ${platform}/${arch}; use client-bin`,
    );
  return target;
}
function verifyDigest(bytes, expected) {
  if (
    !/^[a-f0-9]{64}$/i.test(expected) ||
    createHash("sha256").update(bytes).digest("hex") !== expected.toLowerCase()
  )
    throw new Error("Archive checksum mismatch");
}
async function download(url, deps) {
  const response = await (deps.fetch || fetch)(url, {
    signal: AbortSignal.timeout(60000),
    headers: { "User-Agent": "skimasque-connect" },
  });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 128 * 1024 * 1024) throw new Error("Download too large");
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024) throw new Error("Download too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function binaryOverride(file) {
  const resolved = path.resolve(file),
    stat = await fs.stat(resolved);
  if (!stat.isFile()) throw new Error("Override is not a binary file");
  await fs.access(
    resolved,
    process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
  );
  return resolved;
}
function validateEntries(list) {
  for (const entry of list
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (
      entry.startsWith("/") ||
      entry.startsWith("\\") ||
      entry.includes("\\") ||
      entry.split("/").includes("..") ||
      /^[A-Za-z]:/.test(entry)
    )
      throw new Error("Unsafe archive entry");
  }
}
async function installClient(config, directory, deps = {}) {
  if (config.clientBin) return binaryOverride(config.clientBin);
  const target = targetFor(
    config.platform || process.platform,
    config.arch || process.arch,
  );
  let version = config.version;
  if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version || "")) {
    const info = JSON.parse(
      (
        await download(
          `https://api.github.com/repos/${config.repository}/releases/latest`,
          deps,
        )
      ).toString(),
    );
    version = info.tag_name;
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version || ""))
    throw new Error("No valid release version to install");
  const name = `skimasque-${version}-${target}.tar.gz`,
    base = `https://github.com/${config.repository}/releases/download/${version}`;
  const bytes = await download(`${base}/${name}`, deps),
    checksum = (await download(`${base}/${name}.sha256`, deps))
      .toString()
      .trim();
  const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)$/i.exec(checksum);
  if (!match || match[2] !== name)
    throw new Error("Invalid release checksum manifest");
  verifyDigest(bytes, match[1]);
  const dest = path.join(directory, "client");
  await fs.mkdir(dest, { recursive: true });
  const archive = path.join(dest, name);
  await fs.writeFile(archive, bytes, { mode: 0o600 });
  const command = deps.run || run;
  validateEntries((await command("tar", ["tzf", archive])).stdout);
  await command("tar", ["xzf", archive, "-C", dest, "--strip-components=1"]);
  return binaryOverride(
    path.join(
      dest,
      (config.platform || process.platform) === "win32"
        ? "skimasque-client.exe"
        : "skimasque-client",
    ),
  );
}
module.exports = { installClient, verifyDigest, targetFor };
