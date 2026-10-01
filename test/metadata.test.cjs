"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { readConfig, validateTransparent } = require("../src/config.cjs");
test("README documents every metadata input and valid deployment examples", () => {
  const root = path.join(__dirname, ".."),
    spec = fs.readFileSync(path.join(root, "action.yml"), "utf8");
  const readme = fs.readFileSync(
    process.env.METADATA_README || path.join(root, "README.md"),
    "utf8",
  );
  const inputs = spec.split("inputs:\n")[1].split("outputs:\n")[0];
  const names = [...inputs.matchAll(/^  ([\w-]+):$/gm)].map(
    (match) => match[1],
  );
  const documented = [...readme.matchAll(/^\| `([\w-]+)` \|/gm)].map(
    (match) => match[1],
  );
  assert.deepEqual(documented.sort(), names.sort());
  assert.match(spec, /using: node24/);
  assert.match(spec, /post-if: always\(\)/);
  const env = {
    RUNNER_TEMP: root,
    INPUT_PROXY: "gateway.example.com:443",
    INPUT_AUDIENCE: "https://gateway.example.com",
  };
  const transparent = readConfig({
    ...env,
    INPUT_ROUTES: "10.42.0.0/16,fd42::/48",
    "INPUT_DNS-SERVERS": "10.43.0.53,fd43::53",
    "INPUT_DNS-DOMAINS": "~internal.example",
  });
  assert.equal(transparent.mode, "transparent");
  assert.deepEqual(
    validateTransparent(transparent, ["192.0.2.1"]).families,
    [4, 6],
  );
  assert.equal(readConfig({ ...env, INPUT_MODE: "proxy" }).mode, "proxy");
  for (const value of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "coordinated",
    "id-token: write",
  ])
    assert.ok(readme.includes(value));
  assert.ok(!readme.includes("Everything after it egresses"));
});
