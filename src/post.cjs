"use strict";
const { stop } = require("./stop.cjs");
const { readManifest } = require("./manifest.cjs");
const { reportDiagnostics } = require("./diagnostics.cjs");

async function post(manifestPath, deps = {}) {
  let failed = false;
  try {
    const state = await readManifest(manifestPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    failed = Boolean(state?.failure);
    await stop(manifestPath, deps);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (failed)
      await reportDiagnostics(manifestPath, { write: deps.diagnosticWriter, env: deps.env });
  }
}

if (require.main === module && process.env.STATE_manifest)
  post(process.env.STATE_manifest).catch((error) => {
    console.error(`Skimasque cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
module.exports = { post };
