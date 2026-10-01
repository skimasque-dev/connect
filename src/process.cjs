"use strict";
const fs = require("node:fs/promises");
const { run } = require("./command.cjs");
const { setTimeout: delay } = require("node:timers/promises");
async function identify(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid process identity");
  if (process.platform === "linux") {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      pid,
      started: fields[19],
      executable: await fs.readlink(`/proc/${pid}/exe`),
    };
  }
  if (process.platform === "win32") {
    const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; @{started=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path}|ConvertTo-Json -Compress`;
    const result = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]);
    return { pid, ...JSON.parse(result.stdout) };
  }
  const result = await run("ps", [
    "-p",
    String(pid),
    "-o",
    "lstart=",
    "-o",
    "comm=",
  ]);
  return {
    pid,
    started: result.stdout.trim(),
    executable: result.stdout.trim().slice(24).trim(),
  };
}
async function alive(record) {
  if (!record?.pid) return false;
  try {
    const current = await identify(record.pid);
    return (
      current.started === record.started &&
      current.executable === record.executable
    );
  } catch {
    return false;
  }
}
async function terminateOwned(record) {
  let current;
  try {
    current = await identify(record.pid);
  } catch {
    return;
  }
  if (
    current.started !== record.started ||
    current.executable !== record.executable
  )
    throw new Error(
      "Process creation identity changed; refusing to signal PID",
    );
  process.kill(record.pid, "SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (!(await alive(record))) return;
    await delay(50);
  }
  if (await alive(record)) process.kill(record.pid, "SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (!(await alive(record))) return;
    await delay(50);
  }
  throw new Error("Owned process did not stop");
}
module.exports = { identify, alive, terminateOwned };
