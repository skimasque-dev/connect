"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  createManifest,
  readManifest,
  saveManifest,
} = require("../src/manifest.cjs");
test("state is atomic, instance-specific, contains no credential environment, and rejects corrupt schema", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await createManifest(dir, { mode: "proxy" }),
    second = await createManifest(dir, { mode: "proxy" });
  assert.notEqual(first.path, second.path);
  const state = await readManifest(first.path);
  assert.equal(state.schema, 1);
  assert.ok(!JSON.stringify(state).includes("TOKEN"));
  state.phase = "ready";
  await saveManifest(first.path, state);
  assert.equal((await readManifest(first.path)).phase, "ready");
  await fs.writeFile(first.path, JSON.stringify({ schema: 999 }));
  await assert.rejects(readManifest(first.path), /manifest/);
});

test(
  "transient Windows sharing failures retry atomic replacement",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-state-retry-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const m = await createManifest(dir, { mode: "proxy" });
    const rename = fs.rename;
    let failed = false;
    fs.rename = async (...args) => {
      if (!failed) {
        failed = true;
        throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      }
      return rename(...args);
    };
    try {
      m.state.phase = "ready";
      await saveManifest(m.path, m.state);
    } finally {
      fs.rename = rename;
    }
    assert.equal((await readManifest(m.path)).phase, "ready");
  },
);
