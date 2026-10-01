"use strict";
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { run } = require("./command.cjs");
const SAFE_ENV = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};
const LOCK = "/run/lock/skimasque-connect.flock";

// flock and its helper inherit no credential environment. The helper executes
// network commands while holding the kernel lock. On parent EOF it finishes
// any current mutation before exiting and releasing the lock, even after SIGKILL.
async function acquireLock(elevation) {
  const argv = [
    "-x",
    "-w",
    "5",
    LOCK,
    process.execPath,
    __filename,
    "--helper",
  ];
  const child = spawn(
    elevation ? "sudo" : "flock",
    elevation ? ["-n", "flock", ...argv] : argv,
    {
      env: SAFE_ENV,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let serial = 0,
    stderr = "",
    ended = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = new Promise((resolve) => child.once("close", resolve));
  const fail = (error) => {
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-16384);
  });
  child.once("close", (code) => {
    ended = true;
    fail(new Error(`Network lock helper exited ${code}: ${stderr.trim()}`));
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new Error("Invalid network helper response"));
      child.stdin.end();
      return;
    }
    if (value.ready) {
      readyResolve();
      return;
    }
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    if (value.error) request.reject(new Error(value.error));
    else request.resolve(value.result);
  });
  const timer = setTimeout(() => {
    fail(new Error("Network setup lock unavailable"));
    child.stdin.end();
  }, 7000);
  try {
    await ready;
  } catch (error) {
    child.stdin.end();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    run(program, args, options = {}) {
      if (ended) return Promise.reject(new Error("Network helper exited"));
      return new Promise((resolve, reject) => {
        const id = ++serial;
        pending.set(id, { resolve, reject });
        child.stdin.write(
          JSON.stringify({
            id,
            program,
            args,
            allowFailure: !!options.allowFailure,
          }) + "\n",
        );
      });
    },
    async release() {
      child.stdin.end();
      await exited;
    },
  };
}
async function helper() {
  process.stdout.on("error", () => {}); // parent may have been killed during a mutation
  process.stdout.write(JSON.stringify({ ready: true }) + "\n");
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request;
    try {
      if (line.length > 65536) throw new Error("Network request exceeds limit");
      request = JSON.parse(line);
      if (
        !["ip", "resolvectl"].includes(request.program) ||
        !Array.isArray(request.args) ||
        !request.args.every((arg) => typeof arg === "string")
      )
        throw new Error("Invalid network request");
      const result = await run(request.program, request.args, {
        env: SAFE_ENV,
        allowFailure: request.allowFailure,
      });
      process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ id: request?.id, error: error.message }) + "\n",
      );
    }
  }
}
if (require.main === module)
  helper().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { acquireLock, SAFE_ENV };
