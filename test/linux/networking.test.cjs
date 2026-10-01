"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const dns = require("node:dns/promises");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { run } = require("../../src/command.cjs");
const { start } = require("../../src/main.cjs");
const { stop } = require("../../src/stop.cjs");
const { readManifest } = require("../../src/manifest.cjs");

async function echo(host, port, payload = "hello") {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let body = "";
    socket.setTimeout(5000);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (data) => {
      body += data;
      socket.destroy();
      resolve(body);
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("TCP echo timed out"));
    });
  });
}
async function bulk(host) {
  const bytes = Buffer.alloc(1024 * 1024, 0x5a);
  const digest = require("node:crypto")
    .createHash("sha256")
    .update(bytes)
    .digest();
  const reply = await new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: 18083 });
    const parts = [];
    socket.setTimeout(15000, () =>
      socket.destroy(new Error("half-close bulk timeout")),
    );
    socket.once("connect", () => socket.end(bytes));
    socket.on("data", (p) => parts.push(p));
    socket.once("end", () => resolve(Buffer.concat(parts)));
    socket.once("error", reject);
  });
  assert.deepEqual(reply, digest);
}
async function sharedSourceUdp(host) {
  await new Promise((resolve, reject) => {
    const socket = require("node:dgram").createSocket(
      host.includes(":") ? "udp6" : "udp4",
    );
    const received = new Map();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("shared-source UDP timeout"));
    }, 5000);
    socket.on("error", (e) => {
      clearTimeout(timeout);
      socket.close();
      reject(e);
    });
    socket.on("message", (bytes, info) => {
      received.set(info.port, bytes.toString());
      if (received.size === 2) {
        clearTimeout(timeout);
        socket.close();
        assert.equal(received.get(18080), "first destination");
        assert.equal(received.get(18084), "second destination");
        resolve();
      }
    });
    socket.bind(0, () => {
      socket.send(Buffer.from("first destination"), 18080, host);
      socket.send(Buffer.from("second destination"), 18084, host);
    });
  });
}
async function udpEcho(host, payload, port = 18080) {
  return new Promise((resolve, reject) => {
    const socket = require("node:dgram").createSocket(
      host.includes(":") ? "udp6" : "udp4",
    );
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("native UDP timeout"));
    }, 5000);
    socket.once("error", (e) => {
      clearTimeout(timeout);
      socket.close();
      reject(e);
    });
    socket.once("message", (bytes, info) => {
      clearTimeout(timeout);
      socket.close();
      assert.equal(info.port, port);
      resolve(bytes);
    });
    socket.send(payload, port, host);
  });
}
async function tcpDns(host) {
  const query = Buffer.concat([
    Buffer.from("123401000001000000000000", "hex"),
    Buffer.from("\x02db\x08internal\x04test\x00", "binary"),
    Buffer.from("00010001", "hex"),
  ]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(query.length);
  return new Promise((resolve, reject) => {
    const socket = net.connect(53, host);
    let reply = Buffer.alloc(0);
    socket.setTimeout(5000);
    socket.once("connect", () => socket.write(Buffer.concat([length, query])));
    socket.on("data", (data) => {
      reply = Buffer.concat([reply, data]);
      if (reply.length >= 2 && reply.length >= reply.readUInt16BE(0) + 2) {
        socket.destroy();
        resolve(reply);
      }
    });
    socket.once("error", reject);
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("TCP DNS timed out"));
    });
  });
}
if (process.env.SKIMASQUE_TEST_INSIDE !== "1") {
  test("privileged networking suite runs in isolated mount network and PID namespaces", async () => {
    assert.equal(process.platform, "linux");
    assert.equal(process.getuid(), 0, "run with sudo in CI");
    for (const name of ["SKIMASQUE_CLIENT_BIN", "SKIMASQUE_SERVER_BIN"])
      assert.ok(process.env[name], `${name} is required`);
    const result = await run("bash", [path.join(__dirname, "fixture.sh")], {
      timeout: 180000,
    });
    assert.match(result.stdout, /pass/);
    console.log(result.stdout);
  });
} else {
  test("raw TCP UDP private DNS IPv6 split routes and failure cleanup work through real MASQUE", async (t) => {
    for (const name of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ])
      delete process.env[name];
    const dir = process.env.SKIMASQUE_CASE_DIR;
    const auditDir = path.join(dir, "skm-post-audit");
    await fs.mkdir(auditDir);
    const auditEnv = { ...process.env, RUNNER_TEMP: dir };
    await run(
      process.execPath,
      [path.join(__dirname, "../post-audit/register.cjs")],
      { env: auditEnv },
    );
    assert.notEqual(process.getuid(), 0, "native client must run without root");
    const config = {
      mode: "transparent",
      runnerTemp: dir,
      platform: "linux",
      arch: process.arch,
      proxy: "192.0.2.1:4433",
      authority: "localhost:4433",
      ca: path.join(dir, "ca.pem"),
      audience: "test",
      application: "integration",
      githubOidc: false,
      routes: ["10.42.0.0/24", "fd42::/64"],
      dnsServers: ["10.43.0.53", "fd43::53"],
      dnsDomains: ["~internal.test"],
      clientBin: process.env.SKIMASQUE_CLIENT_BIN,
      httpListen: "127.0.0.1:0",
      socksListen: "127.0.0.1:0",
      startupTimeout: 15000,
      probeTarget: "10.42.0.10:18080",
    };
    const missingReady = path.join(dir, "missing-device-ready.json");
    await assert.rejects(
      run(config.clientBin, [
        "--proxy",
        config.proxy,
        "--authority",
        config.authority,
        "--ca",
        config.ca,
        "proxy",
        "--tun-interface",
        "skm-missing",
        "--ready-file",
        missingReady,
      ]),
      /exist/,
    );
    await assert.rejects(fs.access(missingReady));
    assert.ok(
      !JSON.parse((await run("ip", ["-j", "link", "show"])).stdout).some(
        (link) => link.ifname === "skm-missing",
      ),
    );
    await assert.rejects(
      start({
        ...config,
        clientBin: process.execPath,
        clientPrefix: [
          path.join(__dirname, "../fixtures/client.cjs"),
          "--wrong-tun",
        ],
      }),
      /TUN does not match/,
    );
    const credential = process.env.SKIMASQUE_TOKEN;
    try {
      process.env.SKIMASQUE_TOKEN = "invalid-credential";
      await assert.rejects(start(config));
    } finally {
      process.env.SKIMASQUE_TOKEN = credential;
    }
    assert.ok(
      !JSON.parse((await run("ip", ["-j", "link", "show"])).stdout).some(
        (link) => link.ifname.startsWith("skm"),
      ),
    );
    const crashConfig = path.join(dir, "crash-config.json"),
      crashSignal = path.join(dir, "crash-signal");
    await fs.writeFile(crashConfig, JSON.stringify(config));
    const crashed = spawn(
      process.execPath,
      [path.join(__dirname, "crash-setup.cjs"), crashConfig, crashSignal],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    for (let i = 0; i < 200; i++) {
      if (
        await fs.access(crashSignal).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(50);
    }
    const crashManifest = await fs.readFile(crashSignal, "utf8");
    crashed.kill("SIGKILL");
    await new Promise((resolve) => crashed.once("exit", resolve));
    await run(process.execPath, [path.join(__dirname, "../../src/post.cjs")], {
      env: { ...process.env, STATE_manifest: crashManifest },
    });
    assert.equal((await readManifest(crashManifest)).phase, "cleaned");
    assert.ok(
      !JSON.parse((await run("ip", ["-j", "link", "show"])).stdout).some(
        (link) => link.ifname.startsWith("skm"),
      ),
    );
    const before4 = JSON.parse(
      (await run("ip", ["-j", "-4", "rule", "show"])).stdout,
    );
    const before6 = JSON.parse(
      (await run("ip", ["-j", "-6", "rule", "show"])).stdout,
    );
    await assert.rejects(echo("10.42.0.10", 18080));
    assert.equal(await echo("198.51.100.10", 18081), "public:hello");
    let instance;
    try {
      instance = await start(config);
    } catch (error) {
      for (const name of await fs.readdir(dir)) {
        if (name.startsWith("skimasque-")) {
          for (const log of ["supervisor.log", "client.log", "adapter.log"]) {
            const file = path.join(dir, name, log);
            console.error(log, await fs.readFile(file, "utf8").catch(() => ""));
          }
        }
      }
      throw error;
    }
    t.after(() => stop(instance.manifestPath));
    assert.equal(
      (await readManifest(instance.manifestPath)).processes.adapter,
      undefined,
    );
    assert.equal(await echo("10.42.0.10", 18080), "echo:hello");
    assert.equal(await echo("fd42::10", 18080), "echo:hello");
    await bulk("10.42.0.10");
    await bulk("fd42::10");
    for (const host of ["10.42.0.10", "fd42::10"]) {
      await sharedSourceUdp(host);
      const replies = await Promise.all([
        udpEcho(host, Buffer.from("first")),
        udpEcho(host, Buffer.from("second")),
        udpEcho(host, Buffer.alloc(0)),
        udpEcho(host, Buffer.from("other"), 18084),
      ]);
      assert.deepEqual(replies, [
        Buffer.from("first"),
        Buffer.from("second"),
        Buffer.alloc(0),
        Buffer.from("other"),
      ]);
    }
    const addresses = await dns.lookup("db.internal.test", { all: true });
    assert.ok(addresses.some((a) => a.address === "10.42.0.10"));
    assert.ok(addresses.some((a) => a.address === "fd42::10"));
    assert.equal(await echo("db.internal.test", 18080), "echo:hello");
    const resolver = new dns.Resolver();
    resolver.setServers(["10.43.0.53"]);
    assert.deepEqual(await resolver.resolve4("db.internal.test"), [
      "10.42.0.10",
    ]);
    for (const host of ["10.43.0.53", "fd43::53"])
      assert.deepEqual(
        (await tcpDns(host)).subarray(-4),
        Buffer.from([10, 42, 0, 10]),
      );
    assert.equal(await echo("198.51.100.10", 18081), "public:hello");
    await assert.rejects(echo("10.42.0.10", 18082));
    assert.ok(!process.env.HTTP_PROXY && !process.env.ALL_PROXY);
    // A usable underlying route must remain blocked when the native client dies.
    await run("sudo", [
      "-n",
      "ip",
      "route",
      "add",
      "10.42.0.0/24",
      "via",
      "192.0.2.1",
    ]);
    const state = await readManifest(instance.manifestPath);
    process.kill(state.processes.client.pid, "SIGKILL");
    for (
      let i = 0;
      i < 100 && (await readManifest(instance.manifestPath)).phase !== "failed";
      i++
    )
      await delay(50);
    assert.equal((await readManifest(instance.manifestPath)).phase, "failed");
    await assert.rejects(echo("10.42.0.10", 18080));
    assert.equal(await echo("198.51.100.10", 18081), "public:hello");
    await run(process.execPath, [path.join(__dirname, "../../src/post.cjs")], {
      env: { ...process.env, STATE_manifest: instance.manifestPath },
    });
    await stop(instance.manifestPath);
    await fs.writeFile(
      path.join(auditDir, "manifest-path"),
      instance.manifestPath,
    );
    await run(
      process.execPath,
      [path.join(__dirname, "../post-audit/verify.cjs")],
      { env: auditEnv },
    );
    assert.deepEqual(
      JSON.parse((await run("ip", ["-j", "-4", "rule", "show"])).stdout),
      before4,
    );
    assert.deepEqual(
      JSON.parse((await run("ip", ["-j", "-6", "rule", "show"])).stdout),
      before6,
    );
    assert.ok(
      !JSON.parse((await run("ip", ["-j", "link", "show"])).stdout).some((l) =>
        l.ifname.startsWith("skm"),
      ),
    );
    // Cleanup restores direct routing only at the end of the access scope.
    assert.equal(await echo("10.42.0.10", 18080), "echo:hello");
    await run("sudo", [
      "-n",
      "ip",
      "route",
      "del",
      "10.42.0.0/24",
      "via",
      "192.0.2.1",
    ]);
    const second = await start(config);
    t.after(() => stop(second.manifestPath));
    assert.equal(await echo("10.42.0.10", 18080), "echo:hello");
    await run("sudo", [
      "-n",
      "kill",
      "-INT",
      process.env.SKIMASQUE_TEST_GATEWAY_PID,
    ]);
    for (
      let i = 0;
      i < 100 && (await readManifest(second.manifestPath)).phase !== "failed";
      i++
    )
      await delay(50);
    assert.equal((await readManifest(second.manifestPath)).phase, "failed");
    await assert.rejects(echo("10.42.0.10", 18080));
    await stop(second.manifestPath);
    assert.deepEqual(
      JSON.parse((await run("ip", ["-j", "-4", "rule", "show"])).stdout),
      before4,
    );
    assert.deepEqual(
      JSON.parse((await run("ip", ["-j", "-6", "rule", "show"])).stdout),
      before6,
    );
  });
}
