"use strict";
// Development-only dependencies are installed outside the Action checkout.
const fs = require("node:fs");
const path = require("node:path");
const [modules, schemaFile, ...files] = process.argv.slice(2);
const YAML = require(path.join(path.resolve(modules), "yaml"));
const Ajv = require(path.join(path.resolve(modules), "ajv"));
const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
for (const file of files) {
  const spec = YAML.parse(fs.readFileSync(file, "utf8"));
  if (!validate(spec))
    throw new Error(`${file}: ${JSON.stringify(validate.errors)}`);
  console.log(`${file}: schema valid`);
}
const assert = require("node:assert/strict");
const workflows = path.join(__dirname, "../.github/workflows");
const smoke = YAML.parse(
  fs.readFileSync(path.join(workflows, "smoke.yml"), "utf8"),
);
// Dispatch inputs and PR code must never receive cache-write tokens. Checking
// the workflow policy also catches implicit writes from future cache actions.
assert.equal(smoke["cache-mode"], "read");
const warm = YAML.parse(
  fs.readFileSync(path.join(workflows, "warm-rust-cache.yml"), "utf8"),
);
for (const job of Object.values(smoke.jobs))
  assert.ok(
    !job["cache-mode"] ||
      job["cache-mode"] === "read" ||
      job["cache-mode"] === "none",
  );
assert.deepEqual(Object.keys(warm.on), ["push"]);
assert.deepEqual(warm.on.push.branches, ["main"]);
assert.equal(warm["cache-mode"], "write");
const restore = smoke.jobs.networking.steps.find(
  (s) => s.uses === "actions/cache/restore@v4",
);
const writer = warm.jobs.rust.steps.find((s) => s.uses === "actions/cache@v4");
assert.ok(
  restore && writer,
  "trusted writes and smoke restores must both remain enabled",
);
assert.deepEqual(
  restore.with,
  writer.with,
  "cache writer and reader must address identical build caches",
);
for (const step of warm.jobs.rust.steps) {
  if (step.uses === "actions/checkout@v4") assert.equal(step.with.ref, "main");
  assert.ok(
    !JSON.stringify(step).includes("inputs."),
    "cache writer must not build a caller-supplied ref",
  );
}
console.log("workflow cache trust policy valid");
