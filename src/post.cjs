"use strict";
const { stop } = require("./stop.cjs");
if (process.env.STATE_manifest)
  stop(process.env.STATE_manifest).catch((error) => {
    console.error(`Skimasque cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
