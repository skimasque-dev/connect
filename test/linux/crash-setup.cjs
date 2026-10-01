"use strict";
const fs = require("node:fs/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { createManifest } = require("../../src/manifest.cjs");
const { setupNetwork, preflight } = require("../../src/linux.cjs");
const { validateTransparent } = require("../../src/config.cjs");
async function main() {
  const [file, signal] = process.argv.slice(2),
    config = JSON.parse(await fs.readFile(file, "utf8"));
  const network = await preflight(config);
  const m = await createManifest(config.runnerTemp, config);
  await setupNetwork(
    m.path,
    {
      ...validateTransparent(config, network.gatewayIps),
      uid: network.uid,
      elevation: network.elevation,
    },
    {
      afterMutation: async () => {
        await fs.writeFile(signal, m.path, { mode: 0o600 });
        await delay(60000); // parent test SIGKILLs this process after actual TUN creation
      },
    },
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
