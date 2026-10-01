"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  readConfig,
  validateTransparent,
  validateCapabilities,
} = require("../src/config.cjs");
const { parseIp, parseCidr, contains, overlaps } = require("../src/ip.cjs");

const base = {
  routes: ["10.42.0.0/16"],
  dnsServers: ["10.43.0.53"],
  dnsDomains: ["~internal.example"],
};

test("configuration defaults to transparent and retains explicit proxy mode", () => {
  const env = {
    INPUT_PROXY: "gateway.example:443",
    INPUT_AUDIENCE: "aud",
    RUNNER_TEMP: ".",
  };
  assert.equal(readConfig(env).mode, "transparent");
  assert.equal(
    readConfig({ ...env, INPUT_VERSION: "", GITHUB_ACTION_REF: "v0.9.0" })
      .version,
    "v0.9.0",
  );
  assert.equal(readConfig({ ...env, INPUT_MODE: "proxy" }).mode, "proxy");
  assert.throws(() => readConfig({ ...env, INPUT_MODE: "auto" }), /mode/);
  assert.throws(
    () => readConfig({ ...env, INPUT_LISTEN: "0.0.0.0:1080" }),
    /loopback/,
  );
  assert.throws(
    () => readConfig({ ...env, "INPUT_STARTUP-TIMEOUT": "NaN" }),
    /timeout/,
  );
});

test("CIDR arithmetic covers IPv4 and compressed IPv6 without lexical comparison", () => {
  assert.equal(parseCidr("10.42.8.4/16").canonical, "10.42.0.0/16");
  assert.equal(parseIp("fd00:0:0:0:0:0:0:53").canonical, "fd00::53");
  assert.ok(contains(parseCidr("fd00::/64"), parseIp("fd00::10")));
  assert.ok(!contains(parseCidr("fd00::/64"), parseIp("fd00:0:0:1::10")));
  assert.ok(overlaps(parseCidr("10.0.0.0/8"), parseCidr("10.42.0.0/16")));
});

test("DNS addresses outside destination prefixes get host routes for both families", () => {
  const result = validateTransparent(
    { ...base, dnsServers: ["10.43.0.53", "fd43::53"] },
    ["192.0.2.10"],
  );
  assert.deepEqual(result.families, [4, 6]);
  assert.deepEqual(
    result.routes.map((r) => r.canonical),
    ["10.42.0.0/16", "10.43.0.53/32", "fd43::53/128"],
  );
});

test("gateway overlap, including DNS overlap, is rejected before network setup", () => {
  assert.throws(() => validateTransparent(base, ["10.42.0.1"]), /gateway/);
  assert.throws(() => validateTransparent(base, ["10.43.0.53"]), /gateway/);
  assert.throws(
    () => validateTransparent({ ...base, routes: ["fd42::/64"] }, ["fd42::10"]),
    /gateway/,
  );
});

test("invalid and dangerous ranges cannot alter global or local routing", () => {
  for (const route of [
    "0.0.0.0/0",
    "::/0",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "fe80::/10",
    "224.0.0.0/4",
    "::1/128",
    "0.0.0.0/1",
    "128.0.0.0/1",
    "::ffff:10.0.0.0/120",
    "10.1.1.1/33",
    "10.0.0.1;whoami/8",
    "198.18.0.0/15",
    "fd7a:736b:696d::/64",
  ]) {
    assert.throws(
      () => validateTransparent({ ...base, routes: [route] }, ["192.0.2.10"]),
      undefined,
      route,
    );
  }
  for (const dnsDomains of [
    [],
    ["~."],
    ["-bad"],
    ["internal example"],
    ["$(whoami)"],
  ]) {
    assert.throws(() =>
      validateTransparent({ ...base, dnsDomains }, ["192.0.2.10"]),
    );
  }
  assert.throws(() =>
    validateTransparent({ ...base, dnsServers: [] }, ["192.0.2.10"]),
  );
  assert.throws(() => parseIp("fe80::1%eth0"));
});

test("old clients fail with an actionable compatibility error", () => {
  assert.throws(
    () => validateCapabilities({ schema: 1, features: ["proxy-socks5"] }),
    /newer.*client|required client capabilities/,
  );
  validateCapabilities({
    schema: 1,
    features: [
      "proxy-http",
      "proxy-connect",
      "proxy-socks5",
      "proxy-socks5-udp",
      "proxy-ready-v1",
    ],
  });
});

test("transparent mode requires native capability while proxy remains portable", () => {
  const caps = {
    schema: 1,
    features: [
      "proxy-http",
      "proxy-connect",
      "proxy-socks5",
      "proxy-socks5-udp",
      "proxy-ready-v1",
    ],
  };
  assert.doesNotThrow(() => validateCapabilities(caps, "proxy"));
  assert.throws(
    () => validateCapabilities(caps, "transparent"),
    /proxy-tun-v1/,
  );
  assert.doesNotThrow(() =>
    validateCapabilities(
      { ...caps, features: [...caps.features, "proxy-tun-v1"] },
      "transparent",
    ),
  );
});
