"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { run } = require("../../src/command.cjs");
async function register() {
  const directory = path.join(process.env.RUNNER_TEMP, "skm-post-audit");
  await fs.mkdir(directory, { recursive: true });
  const rules = {};
  for (const family of [4, 6])
    rules[family] = JSON.parse(
      (await run("ip", ["-j", "-N", `-${family}`, "rule", "show"])).stdout,
    );
  await fs.writeFile(
    path.join(directory, "before-rules.json"),
    JSON.stringify(rules),
    { mode: 0o600 },
  );
  console.log("Registered cleanup audit");
}
register().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
