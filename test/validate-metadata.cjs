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
YAML.parse(
  fs.readFileSync(
    path.join(__dirname, "../.github/workflows/smoke.yml"),
    "utf8",
  ),
);
