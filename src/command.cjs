"use strict";
const { spawn } = require("node:child_process");
function run(program, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, argv, {
      windowsHide: true,
      shell: false,
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${program} timed out`));
    }, options.timeout || 30000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const read = (name, data) => {
      size += data.length;
      if (size > 4 * 1024 * 1024) {
        child.kill();
        clearTimeout(timer);
        reject(new Error("Command output exceeds limit"));
      } else if (name === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.on("data", (d) => read("stdout", d));
    child.stderr.on("data", (d) => read("stderr", d));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !options.allowFailure) {
        const error = new Error(
          `${program} exited ${code}: ${(stderr || stdout).trim()}`,
        );
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr, code });
    });
  });
}
module.exports = { run };
