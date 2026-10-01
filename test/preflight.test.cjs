"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { preflight, resolveGateway } = require("../src/linux.cjs");
const { validateTransparent } = require("../src/config.cjs");
test("preflight requires supported OS, TUN, real stub DNS and elevation without secret environment", async () => {
  const config = { platform: "linux", proxy: "gateway.test:443" },
    calls = [];
  const deps = {
    env: {},
    uid: 1001,
    access: async () => {},
    readFile: async (file) =>
      file === "/etc/os-release"
        ? "ID=ubuntu\n"
        : file.includes("disable_ipv6")
          ? "0\n"
          : "nameserver 127.0.0.53\n",
    lookup: async () => [
      { address: "192.0.2.10", family: 4 },
      { address: "fd00::10", family: 6 },
    ],
    run: async (program, args, options) => {
      calls.push({ program, args, options });
      return { code: 0, stdout: "[]" };
    },
  };
  const result = await preflight(config, deps);
  assert.equal(result.elevation, true);
  assert.equal(result.pinnedGateway, "192.0.2.10:443");
  assert.equal(result.authority, "gateway.test:443");
  assert.deepEqual(result.gatewayIps, ["192.0.2.10", "fd00::10"]);
  assert.ok(
    calls.every(
      (c) => c.options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN === undefined,
    ),
  );
  await assert.rejects(
    preflight(config, {
      ...deps,
      access: async () => {
        throw new Error("missing TUN");
      },
    }),
    /TUN/,
  );
  await assert.rejects(
    preflight(config, {
      ...deps,
      readFile: async (file) =>
        file === "/etc/os-release" ? "ID=ubuntu" : "nameserver 8.8.8.8",
    }),
    /stub resolver/,
  );
  await assert.rejects(
    preflight({ ...config, platform: "darwin" }, deps),
    /mode: proxy/,
  );
  await assert.rejects(
    preflight(config, {
      ...deps,
      run: async () => {
        throw new Error("sudo unavailable");
      },
    }),
    /sudo/,
  );
  await assert.rejects(
    preflight(
      { ...config, routes: ["fd42::/64"] },
      {
        ...deps,
        readFile: async (file) =>
          file.includes("disable_ipv6") ? "1\n" : deps.readFile(file),
      },
    ),
    /IPv6/,
  );
  await assert.rejects(
    preflight(config, {
      ...deps,
      env: { HTTPS_PROXY: "http://existing-proxy" },
    }),
    /existing proxy/,
  );
});
test("all resolved gateway addresses are checked for route recursion", async () => {
  const result = await resolveGateway(
    { proxy: "gw:443" },
    {
      lookup: async () => [
        { address: "192.0.2.10" },
        { address: "10.42.0.10" },
      ],
    },
  );
  assert.throws(
    () =>
      validateTransparent(
        {
          routes: ["10.42.0.0/16"],
          dnsServers: ["10.43.0.53"],
          dnsDomains: ["~internal"],
        },
        result.gatewayIps,
      ),
    /gateway/,
  );
});
