"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  readConfig,
  validateTransparent,
  validateCapabilities,
} = require("./config.cjs");
const { installClient, installAdapter } = require("./install.cjs");
const { run } = require("./command.cjs");
const { createManifest, saveManifest } = require("./manifest.cjs");
const { preflight, resolveGateway } = require("./linux.cjs");
const { launchSupervisor, waitReady } = require("./supervisor.cjs");
const { stop } = require("./stop.cjs");
const { proxyEnvironment, writeCommand } = require("./action-files.cjs");

async function start(config, deps = {}) {
  const env = deps.env || process.env;
  if (
    config.githubOidc &&
    (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  )
    throw new Error(
      "No OIDC token available: the job needs permissions: id-token: write",
    );
  const network =
    config.mode === "transparent"
      ? await preflight(config, deps)
      : await resolveGateway(config, deps);
  config = { ...config, ...network };
  if (config.mode === "transparent")
    validateTransparent(config, config.gatewayIps);
  const { path: manifestPath, state } = await createManifest(
      config.runnerTemp,
      config,
    ),
    dir = path.dirname(manifestPath);
  if (env.GITHUB_STATE)
    await writeCommand(env.GITHUB_STATE, "manifest", manifestPath);
  try {
    await fs.writeFile(
      path.join(dir, "stop.cjs"),
      `#!/usr/bin/env node\n"use strict";\nrequire(${JSON.stringify(path.join(__dirname, "stop.cjs"))}).stop(${JSON.stringify(manifestPath)}).catch(error=>{console.error(error.message);process.exitCode=1;});\n`,
      { flag: "wx", mode: 0o700 },
    );
    if (config.mode === "proxy") {
      state.proxyLock = path.join(config.runnerTemp, "skimasque-proxy-active");
      const ownerFile = path.join(dir, "proxy-lock-owner");
      const owner = await fs.open(ownerFile, "wx", 0o600);
      try {
        await owner.writeFile(manifestPath);
        await owner.sync();
      } finally {
        await owner.close();
      }
      // Journal ownership before atomically linking the already-complete owner
      // record into the singleton name. There is never an ownerless lock.
      await saveManifest(manifestPath, state);
      try {
        await fs.link(ownerFile, state.proxyLock);
      } catch (error) {
        if (error.code === "EEXIST")
          throw new Error(
            "A proxy Action instance is already active; stop it before starting another",
          );
        throw error;
      }
      state.proxyLockAcquired = true;
      await saveManifest(manifestPath, state);
      if (deps.proxyLockCreated) await deps.proxyLockCreated();
      state.previousProxy = Object.fromEntries(
        Object.keys(proxyEnvironment("", "")).map((name) => [
          name,
          env[name] ?? null,
        ]),
      );
      await saveManifest(manifestPath, state);
    }
    config.clientBin = await installClient(config, dir, deps);
    const capability = await (deps.run || run)(config.clientBin, [
      ...(config.clientPrefix || []),
      "capabilities",
      "--json",
    ]);
    let value;
    try {
      value = JSON.parse(capability.stdout);
    } catch {
      throw new Error(
        "Client lacks required client capabilities; install a newer skimasque-client",
      );
    }
    validateCapabilities(value);
    if (config.mode === "transparent") {
      config.adapterBin = await installAdapter(config, dir, deps);
      const version = await (deps.run || run)(config.adapterBin, ["--version"]);
      if (!/\bv?2\.7\.0\b/.test(version.stdout))
        throw new Error("Transparent adapter must be pinned tun2socks v2.7.0");
    }
    await launchSupervisor(config, manifestPath);
    const ready = await waitReady(manifestPath, config.startupTimeout + 5000);
    if (config.mode === "proxy" && env.GITHUB_ENV)
      for (const [name, value] of Object.entries(
        proxyEnvironment(ready.http, ready.socks),
      ))
        await writeCommand(env.GITHUB_ENV, name, value);
    if (env.GITHUB_OUTPUT)
      for (const [name, value] of Object.entries({
        mode: config.mode,
        "http-proxy": `http://${ready.http}`,
        "socks-proxy": `socks5h://${ready.socks}`,
        "state-file": manifestPath,
      }))
        await writeCommand(env.GITHUB_OUTPUT, name, value);
    return { manifestPath, ...ready };
  } catch (error) {
    try {
      await stop(manifestPath, deps);
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        `${error.message}; cleanup failed: ${cleanup.message}`,
      );
    }
    throw error;
  }
}
if (require.main === module)
  start(readConfig())
    .then((ready) =>
      console.log(
        `Skimasque setup ready; cleanup state: ${ready.manifestPath}`,
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
module.exports = { start };
