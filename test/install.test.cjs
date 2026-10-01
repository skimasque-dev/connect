"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const {
  installClient,
  verifyDigest,
  targetFor,
} = require("../src/install.cjs");

test("client platform selection preserves existing release platforms", () => {
  assert.equal(targetFor("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(targetFor("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(targetFor("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetFor("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => targetFor("darwin", "x64"), /client-bin/);
});

test("checksum mismatches reject bytes before archive extraction or execution", () => {
  const bytes = Buffer.from("actual");
  assert.throws(() => verifyDigest(bytes, "a".repeat(64)), /checksum/);
  verifyDigest(bytes, createHash("sha256").update(bytes).digest("hex"));
});

test("explicit binary override is checked and avoids any download", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-install-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clientBin = path.join(dir, "client");
  await fs.writeFile(clientBin, "fixture");
  await fs.chmod(clientBin, 0o755);
  const deps = {
    fetch: () => {
      throw new Error("unexpected download");
    },
  };
  assert.equal(await installClient({ clientBin }, dir, deps), clientBin);
  await assert.rejects(
    installClient({ clientBin: path.join(dir, "missing") }, dir, deps),
    /binary|ENOENT/,
  );
});

test("native networking has no external adapter installer", () => {
  assert.equal(require("../src/install.cjs").installAdapter, undefined);
});
