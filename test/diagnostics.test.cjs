"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { reportDiagnostics } = require("../src/diagnostics.cjs");
const { createManifest, saveManifest, readManifest } = require("../src/manifest.cjs");
const { post } = require("../src/post.cjs");
const { run } = require("../src/command.cjs");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-diagnostics-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifest = await createManifest(dir, { mode: "proxy" });
  return { ...manifest, dir: path.dirname(manifest.path) };
}

test("the default diagnostic writer sends errors to the console stderr", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "client.log"), "Error: credential exchange refused\n");
  const result = await run(process.execPath, [
    "-e",
    "require(process.argv[1]).reportDiagnostics(process.argv[2]);",
    require.resolve("../src/diagnostics.cjs"),
    f.path,
  ]);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /SkiMasque client: Error: credential exchange refused/);
});

test("diagnostics redact credentials and prefix every line before printing", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "client.log"),
    "unknown_org\nBearer credential\neyJabc.def.ghi\nrequest-token\n::error::untrusted annotation\n");
  await fs.writeFile(path.join(f.dir, "supervisor.log"), "client exited\n");
  const output = [];
  await reportDiagnostics(f.path, {
    write: (line) => output.push(line),
    env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" },
  });
  const text = output.join("\n");
  assert.match(text, /unknown_org/);
  assert.match(text, /client exited/);
  for (const secret of ["credential", "eyJabc.def.ghi", "request-token"])
    assert.ok(!text.includes(secret));
  assert.ok(output.every((line) => line.startsWith("SkiMasque ")));
});

test("only bounded log tails are printed, without manifest or launcher data", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "client.log"), "old detail\n" + "x".repeat(40000) + "\nlatest error\n");
  await fs.writeFile(path.join(f.dir, "client-launch.json"), "private-launch-data");
  const output = [];
  await reportDiagnostics(f.path, { write: (line) => output.push(line) });
  const text = output.join("\n");
  assert.match(text, /latest error/);
  assert.ok(!text.includes("old detail"));
  assert.ok(!text.includes("private-launch-data"));
  assert.ok(text.length < 17000);
});

test("missing logs and a failing console writer cannot replace an Action error", async (t) => {
  const f = await fixture(t);
  await reportDiagnostics(f.path, { write: () => assert.fail("unexpected output") });
  await fs.writeFile(path.join(f.dir, "client.log"), "client error");
  await reportDiagnostics(f.path, { write: () => { throw new Error("console unavailable"); } });
});

test("post prints recorded background failures and still cleans up", async (t) => {
  const f = await fixture(t);
  f.state.failure = "Client exited after readiness";
  await saveManifest(f.path, f.state);
  await fs.writeFile(path.join(f.dir, "client.log"), "Error: lost gateway connection\n");
  const output = [];
  await post(f.path, { diagnosticWriter: (line) => output.push(line) });
  assert.match(output.join("\n"), /lost gateway connection/);
  assert.equal((await readManifest(f.path)).phase, "cleaned");
});

test("successful post cleanup stays quiet and missing manifests remain harmless", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, "client.log"), "connected successfully\n");
  const output = [];
  await post(f.path, { diagnosticWriter: (line) => output.push(line) });
  await post(path.join(f.dir, "missing.json"), { diagnosticWriter: (line) => output.push(line) });
  assert.deepEqual(output, []);
});
