"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { readManifest } = require("../../src/manifest.cjs");
const { alive } = require("../../src/process.cjs");
const { run } = require("../../src/command.cjs");
const { setTimeout: delay } = require("node:timers/promises");
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
  for (const process of Object.values(state.processes)) {
    for (let i = 0; i < 100 && (await alive(process)); i++) await delay(20);
    assert.equal(await alive(process), false, "owned process still alive");
  }
  if (state.mode === "proxy") assert.equal(state.proxyRestored, true);
  const before = JSON.parse(
    await fs.readFile(
      path.join(process.env.RUNNER_TEMP, "skm-post-audit/before-rules.json"),
      "utf8",
    ),
  );
  for (const family of [4, 6]) {
    const current = JSON.parse(
      (await run("ip", ["-j", "-N", `-${family}`, "rule", "show"])).stdout,
    );
    assert.deepEqual(current, before[family], "post must restore policy rules");
    if (state.network) {
      const routes = await run(
        "ip",
        [
          "-j",
          "-N",
          `-${family}`,
          "route",
          "show",
          "table",
          String(state.network.table),
        ],
        { allowFailure: true },
      );
      assert.deepEqual(
        JSON.parse(routes.stdout || "[]"),
        [],
        "owned table must be empty",
      );
    }
  }
  if (state.network) {
    const links = JSON.parse((await run("ip", ["-j", "link", "show"])).stdout);
    assert.ok(
      !links.some((link) => link.ifname === state.network.interface),
      "owned TUN link must be removed",
    );
    const resolver = await run("resolvectl", ["dns", state.network.interface], {
      allowFailure: true,
    });
    assert.notEqual(resolver.code, 0, "per-link private DNS must be removed");
  }
  console.log(
    "Post hook stopped owned processes and restored proxy/network/DNS state",
  );
}
verify()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.GITHUB_ACTIONS === "true") {
      try {
        await run("bash", [path.join(__dirname, "fixture.sh"), "cleanup"]);
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    }
  });
