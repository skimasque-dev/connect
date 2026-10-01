"use strict";
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { readManifest, saveManifest } = require("./manifest.cjs");
const { alive, terminateOwned } = require("./process.cjs");
const { cleanupNetwork } = require("./linux.cjs");
const { writeCommand } = require("./action-files.cjs");
const { setTimeout: delay } = require("node:timers/promises");
async function requestStop(control) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(`http://${control.address}`),
      socket = net.connect(Number(endpoint.port), endpoint.hostname);
    let data = "";
    socket.setTimeout(15000);
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({ command: "stop", secret: control.secret }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.length > 16384) {
        socket.destroy();
        reject(new Error("Invalid stop response"));
      }
      if (data.includes("\n")) {
        socket.destroy();
        try {
          const reply = JSON.parse(data);
          if (reply.ok) resolve();
          else reject(new Error(reply.error));
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Supervisor stop timed out"));
    });
    socket.once("end", () => {
      if (!data.includes("\n"))
        reject(new Error("Supervisor closed without cleanup confirmation"));
    });
  });
}
async function stop(manifestPath, deps = {}) {
  let state;
  try {
    state = await readManifest(manifestPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (state.phase !== "cleaned") {
    if (state.control && (await alive(state.processes.supervisor)))
      await requestStop(state.control);
    else {
      // No live controller: only signal processes whose creation identity matches.
      for (const name of ["supervisor", "adapter", "client"])
        if (state.processes[name]) await terminateOwned(state.processes[name]);
      // A journaled launcher cannot start before its commit and stops on parent
      // pipe EOF. Its protected receipt also recovers the actual child identity
      // if the supervisor died between spawn and its next manifest write.
      for (const name of ["adapter", "client"]) {
        const launcher = state.processes[`${name}Launcher`];
        if (!launcher) continue;
        for (let i = 0; i < 100 && (await alive(launcher)); i++)
          await delay(50);
        const receipt = state.receipts?.[name];
        if (receipt) {
          if (
            path.dirname(path.resolve(receipt)) !==
            path.dirname(path.resolve(manifestPath))
          )
            throw new Error("Process receipt ownership path mismatch");
          const actual = await fs
            .readFile(receipt, "utf8")
            .then(JSON.parse, (error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (actual) await terminateOwned(actual);
        }
        await terminateOwned(launcher);
      }
      await cleanupNetwork(manifestPath, deps);
      state = await readManifest(manifestPath);
      state.phase = "cleaned";
      await saveManifest(manifestPath, state);
    }
  }
  state = await readManifest(manifestPath);
  if (state.proxyLock) {
    const owner = await fs.readFile(state.proxyLock, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (owner === manifestPath) {
      await fs.unlink(state.proxyLock);
    } else if (owner !== null && state.proxyLockAcquired)
      throw new Error("Proxy lock ownership changed");
  }
  if (state.previousProxy && !state.proxyRestored) {
    if (process.env.GITHUB_ENV)
      for (const [name, value] of Object.entries(state.previousProxy))
        await writeCommand(process.env.GITHUB_ENV, name, value ?? "");
    state.proxyRestored = true;
    await saveManifest(manifestPath, state);
  }
}
if (require.main === module) {
  const args = process.argv.slice(2),
    file = args[args.indexOf("--state") + 1];
  if (!file || !args.includes("--state")) {
    console.error("Usage: node stop.cjs --state STATE_FILE");
    process.exitCode = 1;
  } else
    stop(file).catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
module.exports = { stop };
