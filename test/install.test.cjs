"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const {
  installClient,
  installAdapter,
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
  assert.equal(
    await installAdapter({ adapterBin: clientBin }, dir, deps),
    clientBin,
  );
  await assert.rejects(
    installClient({ clientBin: path.join(dir, "missing") }, dir, deps),
    /binary|ENOENT/,
  );
});

test("an adapter download uses the committed architecture hash", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-adapter-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let extracted = false;
  await assert.rejects(
    installAdapter({ platform: "linux", arch: "x64" }, dir, {
      fetch: async () => new Response(Buffer.from("wrong bytes")),
      run: async () => {
        extracted = true;
        return { stdout: "", code: 0 };
      },
    }),
    /checksum/,
  );
  assert.equal(extracted, false);
});
