"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { identify, terminateOwned, alive } = require("../src/process.cjs");
test("an owned child is terminated but a changed creation identity is refused", async (t) => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    windowsHide: true,
  });
  const exit = new Promise((r) => child.once("exit", r));
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const record = await identify(child.pid);
  assert.equal(await alive(record), true);
  await assert.rejects(
    terminateOwned({ ...record, started: "changed" }),
    /identity/,
  );
  assert.equal(await alive(record), true);
  await terminateOwned(record);
  await exit;
  assert.equal(await alive(record), false);
});
