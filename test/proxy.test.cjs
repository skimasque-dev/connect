"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { start } = require("../src/main.cjs");
const { stop } = require("../src/stop.cjs");

function commands(text) {
  const result = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("<<")) continue;
    const [key, end] = lines[i].split("<<"),
      value = [];
    while (lines[++i] !== end) value.push(lines[i]);
    result[key] = value.join("\n");
  }
  return result;
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-main-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = {
    RUNNER_TEMP: dir,
    GITHUB_ENV: path.join(dir, "env"),
    GITHUB_STATE: path.join(dir, "state"),
    GITHUB_OUTPUT: path.join(dir, "output"),
  };
  const config = {
    mode: "proxy",
    runnerTemp: dir,
    proxy: "192.0.2.10:443",
    audience: "aud",
    httpListen: "127.0.0.1:0",
    socksListen: "127.0.0.1:0",
    githubOidc: false,
    clientBin: process.execPath,
    clientPrefix: [path.join(__dirname, "fixtures/client.cjs")],
    startupTimeout: 3000,
  };
  return { dir, env, config };
}
test("Action startup exports all variables only after both listeners are ready", async (t) => {
  const f = await fixture(t);
  const ready = await start(f.config, { env: f.env });
  t.after(() => stop(ready.manifestPath));
  const values = commands(await fs.readFile(f.env.GITHUB_ENV, "utf8"));
  assert.equal(values.HTTP_PROXY, `http://${ready.http}`);
  assert.equal(values.http_proxy, values.HTTP_PROXY);
  assert.equal(values.HTTPS_PROXY, values.HTTP_PROXY);
  assert.equal(values.https_proxy, values.HTTP_PROXY);
  assert.equal(values.ALL_PROXY, `socks5h://${ready.socks}`);
  assert.equal(values.all_proxy, values.ALL_PROXY);
  assert.equal(values.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(values.no_proxy, values.NO_PROXY);
  assert.ok(
    (await fs.readFile(f.env.GITHUB_STATE, "utf8")).includes(
      ready.manifestPath,
    ),
  );
  await assert.rejects(start(f.config, { env: f.env }), /proxy.*active/);
});
test("unsupported transparent mode rejects before downloading or exporting variables", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    start(
      { ...f.config, mode: "transparent", platform: "win32" },
      {
        env: f.env,
        fetch: () => {
          throw new Error("downloaded");
        },
      },
    ),
    /mode: proxy/,
  );
  await assert.rejects(fs.access(f.env.GITHUB_ENV), { code: "ENOENT" });
});
module.exports = { commands };

test("per-instance stop wrapper provides early cleanup", async (t) => {
  const f = await fixture(t);
  const instance = await start(f.config, { env: f.env });
  t.after(() => stop(instance.manifestPath));
  const wrapper = path.join(path.dirname(instance.manifestPath), "stop.cjs");
  const { run } = require("../src/command.cjs");
  await run(process.execPath, [wrapper]);
  const { readManifest } = require("../src/manifest.cjs");
  assert.equal((await readManifest(instance.manifestPath)).phase, "cleaned");
});
