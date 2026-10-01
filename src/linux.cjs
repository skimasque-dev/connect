"use strict";
const fs = require("node:fs/promises");
const dns = require("node:dns/promises");
const { setTimeout: delay } = require("node:timers/promises");
const { run } = require("./command.cjs");
const { readManifest, saveManifest } = require("./manifest.cjs");
const { parseIp, parseCidr } = require("./ip.cjs");
const { acquireLock } = require("./network-lock.cjs");

const SAFE_ENV = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  LC_ALL: "C",
};
const PROTOCOL = 242,
  LOCK = "/run/lock/skimasque-connect.lock";
function command(deps, elevation) {
  let lock;
  const exec = (program, args, options = {}) =>
    lock
      ? lock.run(program, args, options)
      : (deps.run || run)(
          elevation ? "sudo" : program,
          elevation ? ["-n", program, ...args] : args,
          { ...options, env: SAFE_ENV },
        );
  // Stateful unit boundaries model lock acquisition. Production uses a kernel
  // lock and a credential-free helper for the whole network transaction.
  if (!deps.run) {
    exec.acquire = async () => {
      lock = await acquireLock(elevation);
    };
    exec.release = async () => {
      await lock.release();
      lock = undefined;
    };
  }
  return exec;
}
async function json(exec, args) {
  return JSON.parse((await exec("ip", ["-j", "-N", ...args])).stdout);
}
async function withLock(exec, fn) {
  if (exec.acquire) {
    await exec.acquire();
    try {
      return await fn();
    } finally {
      await exec.release();
    }
  }
  let acquired = false;
  for (let i = 0; i < 100; i++) {
    const result = await exec("mkdir", ["-m", "0700", LOCK], {
      allowFailure: true,
    });
    if (result.code === 0) {
      acquired = true;
      break;
    }
    await delay(50);
  }
  if (!acquired)
    throw new Error(
      "Network setup lock unavailable; inspect /run/lock/skimasque-connect.lock on this dedicated runner",
    );
  try {
    return await fn();
  } finally {
    await exec("rmdir", [LOCK]);
  }
}
function gatewayParts(value) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value);
  if (!match || Number(match[2] || 443) < 1 || Number(match[2] || 443) > 65535)
    throw new Error("Invalid gateway host:port");
  return {
    host: match[1].replace(/^\[|\]$/g, ""),
    port: Number(match[2] || 443),
  };
}
async function resolveGateway(config, deps = {}) {
  const { host, port } = gatewayParts(config.proxy);
  let addresses;
  try {
    addresses = [parseIp(host).canonical];
  } catch {
    addresses = [
      ...new Set(
        (await (deps.lookup || dns.lookup)(host, { all: true })).map(
          (a) => a.address,
        ),
      ),
    ];
  }
  if (!addresses.length) throw new Error("Gateway did not resolve");
  // Client currently binds an IPv4 QUIC socket; pin an IPv4 result explicitly.
  const selected = addresses.find((a) => parseIp(a).family === 4);
  if (!selected)
    throw new Error(
      "The current MASQUE client requires an IPv4 gateway address",
    );
  return {
    gatewayIps: addresses,
    pinnedGateway: `${selected}:${port}`,
    authority:
      config.authority ||
      `${host.includes(":") ? "[" + host + "]" : host}:${port}`,
  };
}
async function preflight(config, deps = {}) {
  if ((config.platform || process.platform) !== "linux")
    throw new Error(
      "Transparent mode requires supported Ubuntu Linux; explicitly select mode: proxy on this runner",
    );
  const read = deps.readFile || fs.readFile,
    access = deps.access || fs.access;
  const environment = deps.env || process.env;
  if (
    [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ].some((name) => environment[name])
  )
    throw new Error(
      "Transparent mode cannot override an existing proxy environment; unset proxy variables or select mode: proxy",
    );
  const osRelease = await read("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/m.test(osRelease.replaceAll('"', "")))
    throw new Error(
      "Transparent mode currently supports dedicated Ubuntu runners; select mode: proxy",
    );
  await access("/dev/net/tun");
  if (
    [...(config.routes || []), ...(config.dnsServers || [])].some((value) =>
      value.includes(":"),
    ) &&
    (await read("/proc/sys/net/ipv6/conf/all/disable_ipv6", "utf8")).trim() !==
      "0"
  )
    throw new Error("IPv6 is disabled on this runner");
  const uid = deps.uid ?? process.getuid(),
    elevation = uid !== 0,
    exec = command(deps, elevation);
  if (elevation)
    await (deps.run || run)("sudo", ["-n", "true"], { env: SAFE_ENV });
  await exec("ip", ["-j", "link", "show"]);
  await exec("resolvectl", ["status"]);
  // resolved must be the resolver actually used by applications, not merely installed.
  const resolver = await read("/etc/resolv.conf", "utf8");
  if (!/^nameserver\s+127\.0\.0\.53\s*$/m.test(resolver))
    throw new Error(
      "Transparent private DNS requires the systemd-resolved stub resolver",
    );
  await exec("unzip", ["-v"]);
  await exec("flock", ["--version"]);
  return { elevation, uid, ...(await resolveGateway(config, deps)) };
}
function sameRule(actual, want, table) {
  const prefix = actual.dst?.includes("/")
    ? actual.dst
    : `${actual.dst}/${actual.dstlen ?? (want.family === 4 ? 32 : 128)}`;
  return (
    Number(actual.priority) === want.priority &&
    prefix === want.to &&
    Number(actual.table) === table &&
    Number(actual.protocol) === PROTOCOL
  );
}
function sameRoute(actual, want, table) {
  const prefix =
    actual.dst === "default"
      ? "default"
      : parseCidr(
          actual.dst.includes("/")
            ? actual.dst
            : `${actual.dst}/${want.family === 4 ? 32 : 128}`,
        ).canonical;
  const type =
    actual.type === "7"
      ? "unreachable"
      : actual.type === "1" || !actual.type
        ? "unicast"
        : actual.type;
  return (
    prefix === want.to &&
    Number(actual.table ?? table) === table &&
    type === want.type &&
    Number(actual.protocol) === PROTOCOL &&
    (want.type !== "unicast" || actual.dev === want.dev)
  );
}
function routeArgs(operation, network, route) {
  return [
    `-${route.family}`,
    "route",
    operation,
    ...(route.type === "unreachable" ? ["unreachable"] : []),
    route.to,
    ...(route.type === "unicast" ? ["dev", network.interface] : []),
    "table",
    String(network.table),
    "proto",
    String(PROTOCOL),
    ...(route.to === "default" ? ["metric", "32767"] : []),
  ];
}
async function ownedLink(exec, network) {
  const links = await json(exec, ["link", "show"]),
    link = links.find((l) => l.ifname === network.interface);
  if (link && link.ifalias !== network.alias) {
    // A crash immediately after tuntap add has no alias yet; only accept that
    // precise incomplete creation intent, with a randomized reserved name.
    if (!(network.linkIntent && !network.aliased && !link.ifalias))
      throw new Error("Network interface ownership changed; refusing cleanup");
  }
  return link;
}
async function setupNetwork(manifestPath, config, deps = {}) {
  const exec = command(deps, config.elevation);
  return withLock(exec, async () => {
    const state = await readManifest(manifestPath);
    if (state.network) throw new Error("Network setup already started");
    const links = await json(exec, ["link", "show"]);
    const rules = [],
      routes = [];
    for (const family of [4, 6]) {
      rules.push(
        ...(await json(exec, [`-${family}`, "rule", "show"])).map((r) => ({
          ...r,
          family,
        })),
      );
      routes.push(
        ...(
          await json(exec, [`-${family}`, "route", "show", "table", "all"])
        ).map((r) => ({ ...r, family })),
      );
    }
    let table = 20000;
    while (
      table < 30000 &&
      (routes.some((r) => Number(r.table) === table) ||
        rules.some((r) => Number(r.table) === table))
    )
      table++;
    if (table === 30000) throw new Error("No free routing table");
    const interfaceName = `skm${state.id.replaceAll("-", "").slice(0, 10)}`;
    if (links.some((l) => l.ifname === interfaceName))
      throw new Error("Interface reservation conflict");
    let priority = 10000;
    const plannedRules = config.routes.map((route) => {
      while (
        priority < 20000 &&
        rules.some((r) => Number(r.priority) === priority)
      )
        priority++;
      if (priority === 20000) throw new Error("No free policy rule priority");
      return {
        family: route.family,
        to: route.canonical,
        priority: priority++,
      };
    });
    const hex = state.id.replaceAll("-", "");
    const source4 = `198.18.${parseInt(hex.slice(0, 2), 16)}.${1 + (parseInt(hex.slice(2, 4), 16) % 254)}/32`;
    const source6 = `fd7a:736b:696d:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:1/128`;
    const network = {
      interface: interfaceName,
      alias: `skimasque:${state.id}`,
      table,
      elevation: config.elevation,
      families: config.families,
      rules: plannedRules,
      routes: [],
      linkIntent: false,
      aliased: false,
      dnsIntent: false,
      intents: [],
      source4,
      source6,
    };
    state.network = network;
    await saveManifest(manifestPath, state);
    const mutation = async (label, program, args) => {
      network.intents.push(label);
      await saveManifest(manifestPath, state);
      await exec(program, args);
      if (deps.afterMutation) await deps.afterMutation(label);
    };
    network.linkIntent = true;
    await mutation("link", "ip", [
      "tuntap",
      "add",
      "dev",
      interfaceName,
      "mode",
      "tun",
      "user",
      String(config.uid),
    ]);
    await mutation("alias", "ip", [
      "link",
      "set",
      "dev",
      interfaceName,
      "alias",
      network.alias,
    ]);
    network.aliased = true;
    await saveManifest(manifestPath, state);
    await mutation("up", "ip", [
      "link",
      "set",
      "dev",
      interfaceName,
      "mtu",
      "1280",
      "up",
    ]);
    if (config.families.includes(4))
      await mutation("address4", "ip", [
        "-4",
        "address",
        "add",
        source4,
        "dev",
        interfaceName,
      ]);
    if (config.families.includes(6))
      await mutation("address6", "ip", [
        "-6",
        "address",
        "add",
        source6,
        "dev",
        interfaceName,
        "nodad",
      ]);
    for (const family of config.families) {
      const fallback = { family, to: "default", type: "unreachable" };
      network.routes.push(fallback);
      await mutation(
        `fallback${family}`,
        "ip",
        routeArgs("add", network, fallback),
      );
    }
    for (const route of config.routes) {
      const owned = {
        family: route.family,
        to: route.canonical,
        type: "unicast",
        dev: interfaceName,
      };
      network.routes.push(owned);
      await mutation(
        `route:${owned.to}`,
        "ip",
        routeArgs("add", network, owned),
      );
    }
    for (const rule of network.rules) {
      // Journal rule intent individually so rollback does not touch planned,
      // never-added rules when a prior mutation fails.
      await mutation(`rule:${rule.priority}`, "ip", [
        `-${rule.family}`,
        "rule",
        "add",
        "priority",
        String(rule.priority),
        "to",
        rule.to,
        "table",
        String(table),
        "protocol",
        String(PROTOCOL),
      ]);
    }
    network.dnsIntent = true;
    await mutation("dns", "resolvectl", [
      "dns",
      interfaceName,
      ...config.dnsServers,
    ]);
    await mutation("domains", "resolvectl", [
      "domain",
      interfaceName,
      ...config.dnsDomains,
    ]);
    await mutation("dns-default", "resolvectl", [
      "default-route",
      interfaceName,
      "no",
    ]);
    await saveManifest(manifestPath, state);
    await verifyNetwork(manifestPath, config, deps);
    return network;
  });
}
async function verifyNetwork(manifestPath, config, deps = {}) {
  const state = await readManifest(manifestPath),
    network = state.network,
    exec = command(deps, network.elevation);
  const link = await ownedLink(exec, network);
  if (!link || link.mtu !== 1280 || !link.flags.includes("UP"))
    throw new Error("TUN interface is not ready");
  for (const family of network.families) {
    const routes = await json(exec, [
      `-${family}`,
      "route",
      "show",
      "table",
      String(network.table),
    ]);
    const rules = await json(exec, [`-${family}`, "rule", "show"]);
    for (const r of network.routes.filter((r) => r.family === family))
      if (!routes.some((a) => sameRoute(a, r, network.table)))
        throw new Error(`Private route not applied: ${r.to}`);
    for (const r of network.rules.filter((r) => r.family === family))
      if (!rules.some((a) => sameRule(a, r, network.table)))
        throw new Error(`Private rule not applied: ${r.to}`);
  }
  for (const [type, values] of [
    ["dns", config.dnsServers],
    ["domain", config.dnsDomains],
    ["default-route", ["no"]],
  ]) {
    const result = await exec("resolvectl", [type, network.interface]);
    for (const value of values)
      if (!result.stdout.includes(value))
        throw new Error(`Private DNS ${type} not applied`);
  }
}
async function blockNetwork(manifestPath, deps = {}) {
  let state = await readManifest(manifestPath);
  if (!state.network) return;
  let network = state.network;
  const exec = command(deps, network.elevation);
  await withLock(exec, async () => {
    state = await readManifest(manifestPath);
    network = state.network;
    if (network.cleaned) return;
    await ownedLink(exec, network);
    for (const route of network.routes.filter((r) => r.to !== "default")) {
      const current = await json(exec, [
        `-${route.family}`,
        "route",
        "show",
        "table",
        String(network.table),
      ]);
      const candidates = current.filter(
        (actual) =>
          parseCidr(
            actual.dst === "default"
              ? route.family === 4
                ? "0.0.0.0/0"
                : "::/0"
              : actual.dst.includes("/")
                ? actual.dst
                : `${actual.dst}/${route.family === 4 ? 32 : 128}`,
          ).canonical === route.to,
      );
      const variants = [
        route,
        ...(route.blockFrom ? [{ ...route, ...route.blockFrom }] : []),
      ];
      if (
        !candidates.length ||
        candidates.some(
          (actual) =>
            !variants.some((want) => sameRoute(actual, want, network.table)),
        )
      )
        throw new Error(
          "Private route ownership changed; refusing replacement",
        );
      // Journal both possible states before replace: a crash or command failure
      // can leave either the original route or its unreachable replacement.
      route.blockFrom ??= {
        type: route.type,
        ...(route.dev ? { dev: route.dev } : {}),
      };
      route.type = "unreachable";
      delete route.dev;
      await saveManifest(manifestPath, state);
      await exec("ip", routeArgs("replace", network, route));
    }
  });
}
async function cleanupNetwork(manifestPath, deps = {}) {
  let state = await readManifest(manifestPath),
    network = state.network;
  if (!network || network.cleaned) return;
  const exec = command(deps, network.elevation);
  await withLock(exec, async () => {
    // Blocking and post can overlap. Read the journal after acquiring the lock.
    state = await readManifest(manifestPath);
    network = state.network;
    if (network.cleaned) return;
    const link = await ownedLink(exec, network),
      errors = [];
    const safely = async (fn) => {
      try {
        await fn();
      } catch (e) {
        errors.push(e);
      }
    };
    if (link && network.dnsIntent)
      await safely(() => exec("resolvectl", ["revert", network.interface]));
    for (const rule of [...network.rules].reverse()) {
      if (!network.intents.includes(`rule:${rule.priority}`)) continue;
      await safely(async () => {
        const current = await json(exec, [`-${rule.family}`, "rule", "show"]);
        const candidates = current.filter(
          (r) => Number(r.priority) === rule.priority,
        );
        if (candidates.some((r) => !sameRule(r, rule, network.table)))
          throw new Error("Policy rule ownership changed");
        if (candidates.length)
          await exec("ip", [
            `-${rule.family}`,
            "rule",
            "del",
            "priority",
            String(rule.priority),
            "to",
            rule.to,
            "table",
            String(network.table),
            "protocol",
            String(PROTOCOL),
          ]);
      });
    }
    // Never remove terminal routes while any failed deletion may leave an
    // intercepting rule behind: lookup would otherwise fall through to main.
    if (errors.length)
      throw new AggregateError(
        errors,
        "Network cleanup failed; private routing retained for retry",
      );
    for (const route of [...network.routes].reverse())
      await safely(async () => {
        const current = await json(exec, [
          `-${route.family}`,
          "route",
          "show",
          "table",
          String(network.table),
        ]);
        const candidates = current.filter(
          (r) =>
            r.dst === route.to ||
            (!r.dst.includes("/") &&
              `${r.dst}/${route.family === 4 ? 32 : 128}` === route.to),
        );
        const variants = [
          route,
          ...(route.blockFrom ? [{ ...route, ...route.blockFrom }] : []),
        ];
        if (
          candidates.some(
            (r) => !variants.some((want) => sameRoute(r, want, network.table)),
          )
        )
          throw new Error("Private route ownership changed");
        for (const actual of candidates) {
          const owned = variants.find((want) =>
            sameRoute(actual, want, network.table),
          );
          await exec("ip", routeArgs("del", network, owned));
        }
      });
    // Keep the interface when rule/route/DNS removal failed: state remains retryable.
    if (!errors.length && link)
      await safely(() =>
        exec("ip", ["link", "delete", "dev", network.interface]),
      );
    if (errors.length)
      throw new AggregateError(
        errors,
        "Network cleanup failed; retry stop with the saved state-file",
      );
    network.cleaned = true;
    await saveManifest(manifestPath, state);
  });
}
module.exports = {
  preflight,
  resolveGateway,
  setupNetwork,
  verifyNetwork,
  cleanupNetwork,
  blockNetwork,
  SAFE_ENV,
};
