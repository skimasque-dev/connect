"use strict";
const fs = require("node:fs/promises");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { identify, terminateOwned } = require("./process.cjs");
const { saveManifest } = require("./manifest.cjs");

async function main() {
  const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  let child,
    identity,
    starting = Promise.resolve(),
    stopping = false,
    stopPromise;
  const lines = readline.createInterface({ input: process.stdin });
  const timer = setTimeout(() => shutdown().catch(report), 30000);
  const finish = () => {
    clearTimeout(timer);
    lines.close();
    process.stdin.destroy();
  };
  const report = (error) => {
    console.error(error.message);
    process.exitCode = 1;
    finish();
  };
  const shutdown = () =>
    (stopPromise ??= (async () => {
      stopping = true;
      await starting.catch(() => {});
      if (identity) await terminateOwned(identity);
      else if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      finish();
    })());
  process.stdin.once("end", () => shutdown().catch(report));
  process.stdin.once("error", () => shutdown().catch(report));
  process.once("SIGTERM", () => shutdown().catch(report));
  process.once("SIGINT", () => shutdown().catch(report));
  lines.once("line", (line) => {
    if (line !== "start" || stopping) {
      shutdown().catch(report);
      return;
    }
    clearTimeout(timer);
    // The supervisor sends start only after this launcher's creation identity
    // is committed. Parent EOF independently stops the actual process, including
    // the interval before its own identity has reached the supervisor journal.
    starting = (async () => {
      if (stopping) return;
      child = spawn(config.binary, config.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "inherit", "inherit"],
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.once("exit", (code) => {
        process.exitCode = code ?? 1;
        finish();
      });
      identity = await identify(child.pid);
      await saveManifest(config.receipt, identity);
    })();
    starting.catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
      shutdown().catch(report);
    });
  });
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
