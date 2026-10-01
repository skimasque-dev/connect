"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writeCommand, proxyEnvironment } = require("../src/action-files.cjs");

test("file commands round trip multiline values without injecting another command", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-files-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "env");
  await writeCommand(file, "VALUE", "one\nOTHER=two");
  const lines = (await fs.readFile(file, "utf8")).split("\n");
  const [name, delimiter] = lines[0].split("<<");
  assert.equal(name, "VALUE");
  assert.equal(lines.slice(1, -2).join("\n"), "one\nOTHER=two");
  assert.equal(lines.at(-2), delimiter);
  await assert.rejects(writeCommand(file, "BAD\nNAME", "value"));
});

test("proxy mode covers uppercase and lowercase clients with the correct protocols", () => {
  assert.deepEqual(proxyEnvironment("127.0.0.1:8080", "127.0.0.1:1080"), {
    HTTP_PROXY: "http://127.0.0.1:8080",
    http_proxy: "http://127.0.0.1:8080",
    HTTPS_PROXY: "http://127.0.0.1:8080",
    https_proxy: "http://127.0.0.1:8080",
    ALL_PROXY: "socks5h://127.0.0.1:1080",
    all_proxy: "socks5h://127.0.0.1:1080",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  });
});
