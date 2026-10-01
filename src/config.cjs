"use strict";
const path = require("node:path");
const { parseIp, parseCidr, contains, overlaps } = require("./ip.cjs");
const FEATURES = [
  "proxy-http",
  "proxy-connect",
  "proxy-socks5",
  "proxy-socks5-udp",
  "proxy-ready-v1",
];
const forbidden = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fe80::/10",
  "ff00::/8",
  "198.18.0.1/32",
  "fd7a:736b:696d::1/128",
].map(parseCidr);
const list = (text) =>
  String(text || "")
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
function loopbackEndpoint(value) {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match || Number(match[2]) > 65535)
    throw new Error("Invalid loopback listener address");
  const host = match[1].replace(/^\[|\]$/g, ""),
    ip = parseIp(host);
  if (
    !(ip.family === 4 ? contains(parseCidr("127.0.0.0/8"), ip) : ip.bits === 1n)
  )
    throw new Error("Listeners must use loopback addresses");
  return `${ip.family === 6 ? "[" + ip.canonical + "]" : ip.canonical}:${Number(match[2])}`;
}
function readConfig(env = process.env) {
  const input = (name, fallback = "") =>
    (env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
  const proxy = input("proxy"),
    audience = input("audience"),
    mode = input("mode", "transparent");
  if (!proxy || !audience) throw new Error("proxy and audience are required");
  if (!["transparent", "proxy"].includes(mode))
    throw new Error("mode must be transparent or proxy");
  const startupTimeout = Number(input("startup-timeout", "30"));
  if (
    !Number.isFinite(startupTimeout) ||
    startupTimeout < 1 ||
    startupTimeout > 300
  )
    throw new Error("startup timeout must be 1..300 seconds");
  const repository = input("repository", "skimasque-dev/skimasque");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid release repository");
  for (const value of [
    proxy,
    audience,
    input("authority"),
    input("application"),
  ])
    if (/[\r\n\0]/.test(value))
      throw new Error("Input contains invalid characters");
  if (!env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required");
  return {
    mode,
    proxy,
    audience,
    authority: input("authority"),
    application: input("application"),
    ca: input("ca"),
    socksListen: loopbackEndpoint(input("listen", "127.0.0.1:1080")),
    httpListen: loopbackEndpoint(input("http-listen", "127.0.0.1:8080")),
    routes: list(input("routes")),
    dnsServers: list(input("dns-servers")),
    dnsDomains: list(input("dns-domains")),
    version: input("version") || env.GITHUB_ACTION_REF || "main",
    repository,
    clientBin: input("client-bin"),
    adapterBin: input("tun2socks-bin"),
    probeTarget: input("probe-target"),
    startupTimeout: startupTimeout * 1000,
    runnerTemp: path.resolve(env.RUNNER_TEMP),
    platform: process.platform,
    arch: process.arch,
    githubOidc: true,
  };
}
function allowed(cidr) {
  if (cidr.prefix === 0 || forbidden.some((f) => overlaps(f, cidr)))
    throw new Error(
      `Unsupported local, reserved, source, or default route: ${cidr.canonical}`,
    );
}
function validateTransparent(config, gatewayIps) {
  if (
    !config.routes.length ||
    !config.dnsServers.length ||
    !config.dnsDomains.length
  )
    throw new Error(
      "Transparent mode requires routes, dns-servers and dns-domains",
    );
  const routes = config.routes.map(parseCidr),
    servers = config.dnsServers.map(parseIp);
  const domains = [...new Set(config.dnsDomains.map((d) => d.toLowerCase()))];
  for (const domain of domains) {
    const plain = domain.startsWith("~") ? domain.slice(1) : domain;
    if (
      plain.length > 253 ||
      !plain ||
      plain
        .split(".")
        .some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
    )
      throw new Error(`Invalid private DNS domain: ${domain}`);
  }
  for (const server of servers)
    if (!routes.some((r) => contains(r, server)))
      routes.push(
        parseCidr(`${server.canonical}/${server.family === 4 ? 32 : 128}`),
      );
  const unique = [...new Map(routes.map((r) => [r.canonical, r])).values()];
  for (const route of unique) {
    allowed(route);
    if (gatewayIps.some((ip) => contains(route, parseIp(ip))))
      throw new Error(`Private route overlaps gateway: ${route.canonical}`);
  }
  return {
    routes: unique,
    dnsServers: [...new Set(servers.map((s) => s.canonical))],
    dnsDomains: domains,
    families: [...new Set(unique.map((r) => r.family))].sort(),
  };
}
function validateCapabilities(value) {
  if (
    value?.schema !== 1 ||
    !Array.isArray(value.features) ||
    FEATURES.some((f) => !value.features.includes(f))
  )
    throw new Error(
      "Missing required client capabilities; install a newer skimasque-client release",
    );
}
module.exports = {
  readConfig,
  validateTransparent,
  validateCapabilities,
  loopbackEndpoint,
};
