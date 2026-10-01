"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createManifest, readManifest } = require("../src/manifest.cjs");
const { launchSupervisor, waitReady } = require("../src/supervisor.cjs");
const { stop } = require("../src/stop.cjs");

async function fixture(t, extras = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-supervisor-"));
  const m = await createManifest(dir, { mode: "proxy" });
  const config = {
    mode: "proxy",
    clientBin: process.execPath,
    clientPrefix: [path.join(__dirname, "fixtures/client.cjs")],
    httpListen: "127.0.0.1:0",
    socksListen: "127.0.0.1:0",
    pinnedGateway: "192.0.2.10:443",
    authority: "gateway.test:443",
    audience: "test",
    githubOidc: false,
    startupTimeout: 10000,
    ...extras,
  };
  t.after(async () => {
    await stop(m.path).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { path: m.path, config };
}
test("supervisor publishes both listeners and explicit stop is idempotent", async (t) => {
  const f = await fixture(t);
  await launchSupervisor(f.config, f.path);
  const ready = await waitReady(f.path, 15000);
  assert.match(ready.http, /127\.0\.0\.1:\d+/);
  assert.match(ready.socks, /127\.0\.0\.1:\d+/);
  await stop(f.path);
  await stop(f.path);
  assert.equal((await readManifest(f.path)).phase, "cleaned");
});
test("a relay that exits after readiness becomes failed and is cleaned by post", async (t) => {
  const f = await fixture(t);
  await launchSupervisor(f.config, f.path);
  await waitReady(f.path, 15000);
  process.kill((await readManifest(f.path)).processes.client.pid, "SIGTERM");
  for (
    let i = 0;
    i < 100 && (await readManifest(f.path)).phase !== "failed";
    i++
  )
    await new Promise((r) => setTimeout(r, 50));
  assert.equal((await readManifest(f.path)).phase, "failed");
  await stop(f.path);
  assert.equal((await readManifest(f.path)).phase, "cleaned");
});
test("a readiness timeout terminates the child and records setup failure", async (t) => {
  const f = await fixture(t, {
    clientPrefix: [path.join(__dirname, "fixtures/client.cjs"), "--no-ready"],
    startupTimeout: 200,
  });
  await launchSupervisor(f.config, f.path);
  await assert.rejects(waitReady(f.path, 15000), /ready|timed out/);
  await stop(f.path);
  assert.equal((await readManifest(f.path)).phase, "cleaned");
});
test("a mismatched gateway in readiness fails startup", async (t) => {
  const f = await fixture(t, {
    clientPrefix: [
      path.join(__dirname, "fixtures/client.cjs"),
      "--wrong-gateway",
    ],
  });
  await launchSupervisor(f.config, f.path);
  await assert.rejects(waitReady(f.path, 15000), /gateway|ready/);
});

test("stop during initialization waits for rollback and prevents later readiness", async (t) => {
  const f = await fixture(t, {
    clientPrefix: [path.join(__dirname, "fixtures/client.cjs"), "--no-ready"],
  });
  await launchSupervisor(f.config, f.path);
  for (let i = 0; i < 100 && !(await readManifest(f.path)).control; i++)
    await new Promise((r) => setTimeout(r, 50));
  await stop(f.path);
  await stop(f.path);
  assert.equal((await readManifest(f.path)).phase, "cleaned");
});
