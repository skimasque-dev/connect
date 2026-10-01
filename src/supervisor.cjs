"use strict";
const fs = require("node:fs/promises");
const syncFs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { readManifest, saveManifest } = require("./manifest.cjs");
const { identify, alive } = require("./process.cjs");
const { loopbackEndpoint } = require("./config.cjs");
const {
  setupNetwork,
  verifyNetwork,
  cleanupNetwork,
  blockNetwork,
} = require("./linux.cjs");
const { validateTransparent } = require("./config.cjs");

async function launchSupervisor(config, manifestPath) {
  const state = await readManifest(manifestPath);
  state.config = config;
  state.phase = "launching";
  await saveManifest(manifestPath, state);
  const log = syncFs.openSync(
    path.join(path.dirname(manifestPath), "supervisor.log"),
    "a",
    0o600,
  );
  const child = spawn(process.execPath, [__filename, "--state", manifestPath], {
    detached: true,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", log, log],
  });
  syncFs.closeSync(log);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    state.processes.supervisor = await identify(child.pid);
    state.phase = "starting";
    await saveManifest(manifestPath, state);
  } catch (error) {
    child.kill();
    throw error;
  }
  child.unref();
}
async function waitReady(manifestPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readManifest(manifestPath);
    if (state.phase === "ready") return state.ready;
    if (["failed", "cleaned"].includes(state.phase))
      throw new Error(state.failure || "Proxy did not become ready");
    if (
      state.processes.supervisor &&
      !(await alive(state.processes.supervisor))
    )
      throw new Error("Supervisor exited before readiness");
    await delay(100);
  }
  throw new Error("Proxy startup timed out before readiness");
}
function connectionArgs(config) {
  const args = [
    ...(config.clientPrefix || []),
    "--proxy",
    config.pinnedGateway || config.proxy,
  ];
  if (config.githubOidc)
    args.push("--github-oidc", "--oidc-audience", config.audience);
  for (const [flag, value] of [
    ["--authority", config.authority],
    ["--ca", config.ca],
    ["--app", config.application],
  ])
    if (value) args.push(flag, value);
  return args;
}
async function readReady(file, child, config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Client exited before readiness");
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      if (value.schema !== 1 || value.pid !== child.pid)
        throw new Error("Client ready record has wrong process identity");
      if (value.gateway !== config.pinnedGateway)
        throw new Error(
          "Client ready gateway does not match validated gateway",
        );
      loopbackEndpoint(value.http);
      loopbackEndpoint(value.socks);
      if (value.http.endsWith(":0") || value.socks.endsWith(":0"))
        throw new Error("Client ready record has unbound listeners");
      return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error("Client timed out before readiness");
}
async function tcpProbe(target, timeoutMs = 10000) {
  const url = new URL(`tcp://${target}`);
  if (!url.port || url.pathname)
    throw new Error("probe-target must be host:port");
  await new Promise((resolve, reject) => {
    const socket = net.connect({
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port),
    });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Destination probe timed out"));
    });
  });
}
async function proxyProbe(proxy, target) {
  await new Promise((resolve, reject) => {
    const endpoint = new URL(`http://${proxy}`),
      socket = net.connect(Number(endpoint.port), endpoint.hostname);
    let head = "";
    socket.setTimeout(10000);
    socket.once("connect", () =>
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    socket.on("data", (data) => {
      head += data;
      if (head.includes("\r\n\r\n")) {
        socket.destroy();
        if (/^HTTP\/1\.[01] 200\b/.test(head)) resolve();
        else reject(new Error("Destination probe refused by gateway"));
      } else if (head.length > 16384) {
        socket.destroy();
        reject(new Error("Invalid probe reply"));
      }
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("Destination probe timed out"));
    });
    socket.once("end", () => {
      if (!head.includes("\r\n\r\n"))
        reject(new Error("Destination probe closed early"));
    });
  });
}
async function worker(manifestPath) {
  let state = await readManifest(manifestPath);
  for (let i = 0; state.phase === "launching" && i < 300; i++) {
    await delay(100);
    state = await readManifest(manifestPath);
  }
  if (state.phase !== "starting")
    throw new Error("Supervisor launch was not committed");
  const config = state.config,
    dir = path.dirname(manifestPath),
    children = [];
  let stopping = false,
    readyPublished = false,
    stopPromise,
    finishInitialization;
  const initialized = new Promise((resolve) => {
    finishInitialization = resolve;
  });
  const controlSecret = randomBytes(32).toString("hex");
  const persist = () => saveManifest(manifestPath, state);
  const stopChild = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, delay(2000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, delay(2000)]);
    }
    if (child.exitCode === null && child.signalCode === null)
      throw new Error("Child process did not stop");
  };
  const shutdown = () =>
    (stopPromise ??= (async () => {
      stopping = true;
      const errors = [];
      for (const child of [...children].reverse())
        try {
          await stopChild(child);
        } catch (error) {
          errors.push(error);
        }
      await initialized;
      for (const child of [...children].reverse())
        try {
          await stopChild(child);
        } catch (error) {
          errors.push(error);
        }
      try {
        await cleanupNetwork(manifestPath);
      } catch (error) {
        errors.push(error);
      }
      state = await readManifest(manifestPath);
      state.phase = errors.length ? "failed" : "cleaned";
      state.failure = errors.length
        ? errors.map((e) => e.message).join("; ")
        : state.failure;
      await persist();
      if (errors.length)
        throw new AggregateError(
          errors,
          "Stop failed; retained state for retry",
        );
    })());
  const server = net.createServer((socket) => {
    let input = "";
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("data", async (chunk) => {
      input += chunk;
      if (input.length > 2048) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      let request;
      try {
        request = JSON.parse(input);
      } catch {
        socket.destroy();
        return;
      }
      if (request.secret !== controlSecret || request.command !== "stop") {
        socket.destroy();
        return;
      }
      try {
        await shutdown();
        socket.end(JSON.stringify({ ok: true }) + "\n");
        server.close();
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n");
        stopPromise = undefined;
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  state.control = {
    address: `127.0.0.1:${server.address().port}`,
    secret: controlSecret,
  };
  await persist();
  const handleSignal = () => {
    shutdown()
      .then(() => server.close())
      .catch((error) => {
        console.error(error.message);
        server.close();
        process.exitCode = 1;
      });
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
  const spawnChild = async (name, binary, args) => {
    if (stopping) throw new Error("Startup stopped");
    const log = syncFs.openSync(path.join(dir, `${name}.log`), "a", 0o600);
    const child = spawn(binary, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", log, log],
    });
    syncFs.closeSync(log);
    children.push(child);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    state.processes[name] = await identify(child.pid);
    await persist();
    child.on("error", (error) => console.error(`${name}: ${error.message}`));
    return child;
  };
  try {
    const client = await spawnChild("client", config.clientBin, [
      ...connectionArgs(config),
      "proxy",
      "--http-listen",
      config.httpListen,
      "--socks-listen",
      config.socksListen,
      "--ready-file",
      path.join(dir, "client-ready.json"),
    ]);
    const ready = await readReady(
      path.join(dir, "client-ready.json"),
      client,
      config,
      config.startupTimeout,
    );
    if (stopping) throw new Error("Startup stopped");
    if (config.mode === "transparent") {
      const networkConfig = {
        ...validateTransparent(config, config.gatewayIps),
        uid: config.uid,
        elevation: config.elevation,
      };
      await setupNetwork(manifestPath, networkConfig);
      state = await readManifest(manifestPath);
      const adapter = await spawnChild("adapter", config.adapterBin, [
        "--device",
        `tun://${state.network.interface}`,
        "--proxy",
        `socks5://${ready.socks}`,
        "--loglevel",
        "warn",
      ]);
      await delay(300);
      if (adapter.exitCode !== null || adapter.signalCode !== null)
        throw new Error(
          "Transparent adapter exited during startup; inspect adapter.log",
        );
      await verifyNetwork(manifestPath, networkConfig);
    }
    if (config.probeTarget) {
      if (config.mode === "transparent") await tcpProbe(config.probeTarget);
      else await proxyProbe(ready.http, config.probeTarget);
    }
    if (stopping) throw new Error("Startup stopped");
    if (children.some((c) => c.exitCode !== null || c.signalCode !== null))
      throw new Error("Proxy child exited during startup");
    state.ready = { http: ready.http, socks: ready.socks };
    state.phase = "ready";
    await persist();
    readyPublished = true;
    finishInitialization();
    // Keep control service alive after a failure, so post can perform cleanup.
    const exited = await Promise.race(
      children.map(
        (c) =>
          new Promise((resolve) => {
            if (c.exitCode !== null || c.signalCode !== null) resolve(c);
            else c.once("exit", () => resolve(c));
          }),
      ),
    );
    if (!stopping) {
      state.phase = "failed";
      state.failure = `${exited === client ? "Client" : "Transparent adapter"} exited after startup`;
      await persist();
      await blockNetwork(manifestPath);
      for (const child of children) await stopChild(child);
    }
  } catch (error) {
    finishInitialization();
    if (stopping) return;
    state = await readManifest(manifestPath);
    state.failure = error.message;
    state.phase = "failed";
    await persist();
    if (readyPublished) {
      try {
        await blockNetwork(manifestPath);
      } catch (e) {
        console.error(e.message);
      }
    } else {
      try {
        await cleanupNetwork(manifestPath);
      } catch (e) {
        console.error(e.message);
      }
    }
    for (const child of children) {
      try {
        await stopChild(child);
      } catch (e) {
        console.error(e.message);
      }
    }
  }
}
if (require.main === module) {
  const args = process.argv.slice(2),
    file = args[args.indexOf("--state") + 1];
  worker(file).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { launchSupervisor, waitReady, worker, connectionArgs };
