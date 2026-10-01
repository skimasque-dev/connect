"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
async function createManifest(directory, config) {
  const id = randomUUID(),
    dir = path.join(directory, `skimasque-${id}`);
  await fs.mkdir(dir, { mode: 0o700 });
  const state = {
    schema: 1,
    id,
    phase: "preflight",
    mode: config.mode,
    ownerUid: process.getuid?.() ?? null,
    network: null,
    processes: {},
    failure: null,
  };
  const file = path.join(dir, "manifest.json");
  await saveManifest(file, state);
  return { path: file, state };
}
async function saveManifest(file, state) {
  const temp = `${file}.${randomUUID()}.tmp`,
    handle = await fs.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, file);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function readManifest(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("Invalid manifest file");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  if (
    state.schema !== 1 ||
    !/^[a-f0-9-]{36}$/.test(state.id) ||
    !["transparent", "proxy"].includes(state.mode) ||
    !state.processes
  )
    throw new Error("Unsupported or invalid manifest schema");
  if (
    path.basename(path.dirname(path.resolve(file))) !==
      `skimasque-${state.id}` ||
    path.basename(file) !== "manifest.json"
  )
    throw new Error("Manifest ownership path mismatch");
  if (process.getuid && state.ownerUid !== process.getuid())
    throw new Error("Manifest user ownership mismatch");
  return state;
}
module.exports = { createManifest, saveManifest, readManifest };
