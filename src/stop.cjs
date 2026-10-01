"use strict";
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { readManifest, saveManifest } = require("./manifest.cjs");
const { alive, terminateOwned } = require("./process.cjs");
const { cleanupNetwork } = require("./linux.cjs");
const { writeCommand } = require("./action-files.cjs");
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
      await cleanupNetwork(manifestPath, deps);
      state = await readManifest(manifestPath);
      state.phase = "cleaned";
      await saveManifest(manifestPath, state);
    }
  }
  state = await readManifest(manifestPath);
  if (state.proxyLock) {
    const owner = await fs
      .readFile(path.join(state.proxyLock, "owner"), "utf8")
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (owner === manifestPath) {
      await fs.unlink(path.join(state.proxyLock, "owner"));
      await fs.rmdir(state.proxyLock);
    } else if (owner !== null) throw new Error("Proxy lock ownership changed");
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
