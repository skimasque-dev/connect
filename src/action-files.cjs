"use strict";
const { randomUUID } = require("node:crypto");
const { appendFile } = require("node:fs/promises");
async function writeCommand(file, key, value) {
  if (!file || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key))
    throw new Error("Invalid file command");
  const delimiter = `skimasque_${randomUUID()}`;
  await appendFile(
    file,
    `${key}<<${delimiter}\n${String(value)}\n${delimiter}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
function proxyEnvironment(http, socks) {
  return {
    HTTP_PROXY: `http://${http}`,
    http_proxy: `http://${http}`,
    HTTPS_PROXY: `http://${http}`,
    https_proxy: `http://${http}`,
    ALL_PROXY: `socks5h://${socks}`,
    all_proxy: `socks5h://${socks}`,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}
module.exports = { writeCommand, proxyEnvironment };
