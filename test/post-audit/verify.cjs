"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { readManifest } = require("../../src/manifest.cjs");
const { alive } = require("../../src/process.cjs");
async function verify() {
  const file = (
    await fs.readFile(
      path.join(process.env.RUNNER_TEMP, "skm-post-audit/manifest-path"),
      "utf8",
    )
  ).trim();
  assert.ok(file, "Action must publish its state output");
  const state = await readManifest(file);
  assert.equal(
    state.phase,
    "cleaned",
    "registered post hook must finish cleanup",
  );
  for (const process of Object.values(state.processes))
    assert.equal(await alive(process), false, "owned process still alive");
  assert.equal(state.proxyRestored, true);
  console.log(
    "Actual Action post hook stopped processes and restored proxy state",
  );
}
verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
