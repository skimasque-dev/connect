"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createManifest, readManifest } = require("../src/manifest.cjs");
const {
  setupNetwork,
  cleanupNetwork,
  blockNetwork,
} = require("../src/linux.cjs");
const { validateTransparent } = require("../src/config.cjs");

// A stateful ip/resolvectl boundary; privileged Linux is unavailable on this host.
// Assertions examine effective rules/routes and ownership, not mock call counts.
class Kernel {
  constructor() {
    this.links = [];
    this.rules = [];
    this.routes = [];
    this.dns = new Map();
    this.mutations = 0;
    this.failAt = 0;
    this.environments = [];
  }
  async run(program, args, options = {}) {
    this.environments.push(options.env);
    if (program === "sudo") {
      args = args.slice(1);
      program = args.shift();
    }
    if (program === "mkdir" || program === "rmdir")
      return { stdout: "", code: 0 };
    if (program === "resolvectl") {
      if (args[0] === "status")
        return { stdout: "Link resolver ready", code: 0 };
      if (args.length === 2) {
        const d = this.dns.get(args[1]) || {};
        return { stdout: `Link: ${(d[args[0]] || []).join(" ")}`, code: 0 };
      }
      this.mutate();
      if (args[0] === "revert") this.dns.delete(args[1]);
      else {
        const d = this.dns.get(args[1]) || {};
        d[args[0]] = args.slice(2);
        this.dns.set(args[1], d);
      }
      return { stdout: "", code: 0 };
    }
    if (program !== "ip") throw new Error(`Unexpected command ${program}`);
    const family = args.includes("-6") ? 6 : 4;
    const a = args.filter((x) => !["-j", "-N", "-4", "-6"].includes(x));
    const key = (name) => {
      const i = a.indexOf(name);
      return i >= 0 ? a[i + 1] : undefined;
    };
    if (a[0] === "link" && a[1] === "show")
      return { stdout: JSON.stringify(this.links), code: 0 };
    if (a[0] === "address" && a[1] === "show")
      return {
        stdout: JSON.stringify(
          this.links.map((l) => ({ ...l, addr_info: [] })),
        ),
        code: 0,
      };
    if (a[0] === "rule" && a[1] === "show")
      return {
        stdout: JSON.stringify(
          this.rules
            .filter((r) => r.family === family)
            .map((r) => {
              const [dst, prefix] = r.dst.split("/");
              return {
                ...r,
                dst,
                dstlen: Number(prefix),
                table: String(r.table),
                protocol: String(r.protocol),
              };
            }),
        ),
        code: 0,
      };
    if (a[0] === "route" && a[1] === "show") {
      return {
        stdout: JSON.stringify(
          this.routes
            .filter(
              (r) =>
                r.family === family &&
                (key("table") === "all" || r.table === Number(key("table"))),
            )
            .map((r) => ({
              ...r,
              dst:
                r.dst.endsWith("/32") || r.dst.endsWith("/128")
                  ? r.dst.split("/")[0]
                  : r.dst,
              type: r.type === "unreachable" ? "7" : "1",
              protocol: String(r.protocol),
            })),
        ),
        code: 0,
      };
    }
    this.mutate();
    if (a[0] === "tuntap" && a[1] === "add") {
      this.links.push({
        ifname: key("dev"),
        ifalias: "",
        mtu: 1500,
        flags: [],
      });
    } else if (a[0] === "link" && a[1] === "set") {
      const l = this.links.find((l) => l.ifname === key("dev"));
      if (!l) throw new Error("Missing link");
      if (key("alias")) l.ifalias = key("alias");
      if (key("mtu")) l.mtu = Number(key("mtu"));
      if (a.includes("up")) l.flags = ["UP"];
    } else if (a[0] === "link" && a[1] === "delete") {
      this.links = this.links.filter((l) => l.ifname !== key("dev"));
      this.dns.delete(key("dev"));
    } else if (a[0] === "address") {
    } else if (a[0] === "route") {
      const type = a[2] === "unreachable" ? "unreachable" : "unicast",
        dst = type === "unreachable" ? a[3] : a[2];
      const r = {
        family,
        type,
        dst,
        dev: key("dev"),
        table: Number(key("table")),
        protocol: Number(key("proto")),
        metric: key("metric") ? Number(key("metric")) : undefined,
      };
      if (a[1] === "del")
        this.routes = this.routes.filter(
          (x) =>
            !(
              x.family === family &&
              x.dst === dst &&
              x.table === r.table &&
              x.type === type
            ),
        );
      else {
        if (a[1] === "replace")
          this.routes = this.routes.filter(
            (x) =>
              !(x.family === family && x.dst === dst && x.table === r.table),
          );
        this.routes.push(r);
      }
    } else if (a[0] === "rule") {
      const r = {
        family,
        priority: Number(key("priority")),
        dst: key("to"),
        table: Number(key("table")),
        protocol: Number(key("protocol")),
      };
      if (a[1] === "del")
        this.rules = this.rules.filter(
          (x) =>
            !(
              x.family === family &&
              x.priority === r.priority &&
              x.dst === r.dst &&
              x.table === r.table
            ),
        );
      else this.rules.push(r);
    } else throw new Error(`Unknown ip operation ${a}`);
    return { stdout: "", code: 0 };
  }
  mutate() {
    this.mutations++;
    if (this.failAt === this.mutations)
      throw new Error("Injected mutation failure");
  }
  privateResult(ip) {
    const r = this.rules.find((r) => r.dst === "10.42.0.0/16");
    if (!r) return "direct";
    const route = this.routes.find(
      (x) => x.table === r.table && x.dst === "10.42.0.0/16",
    );
    return route?.type === "unicast" ? "tunnel" : "unreachable";
  }
}
async function fixture(t, kernel = new Kernel()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skm-network-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifest = await createManifest(dir, { mode: "transparent" });
  const config = {
    ...validateTransparent(
      {
        routes: ["10.42.0.0/16", "fd42::/64"],
        dnsServers: ["10.43.0.53", "fd43::53"],
        dnsDomains: ["~internal"],
      },
      ["192.0.2.10"],
    ),
    elevation: true,
    uid: 1001,
  };
  return {
    manifest: manifest.path,
    config,
    kernel,
    deps: { run: kernel.run.bind(kernel) },
  };
}

test("owned routing includes both DNS families and unreachable fallback and cleans twice", async (t) => {
  const f = await fixture(t);
  await setupNetwork(f.manifest, f.config, f.deps);
  assert.equal(f.kernel.privateResult("10.42.0.1"), "tunnel");
  assert.ok(f.kernel.routes.some((r) => r.dst === "fd43::53/128"));
  assert.equal(
    f.kernel.routes.filter(
      (r) => r.dst === "default" && r.type === "unreachable",
    ).length,
    2,
  );
  assert.ok(
    !f.kernel.rules.some((r) => r.dst === "0.0.0.0/0" || r.dst === "::/0"),
  );
  for (const env of f.kernel.environments) {
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
    assert.equal(env.SKIMASQUE_TOKEN, undefined);
  }
  await blockNetwork(f.manifest, f.deps);
  assert.equal(f.kernel.privateResult("10.42.0.1"), "unreachable");
  await cleanupNetwork(f.manifest, f.deps);
  await cleanupNetwork(f.manifest, f.deps);
  assert.deepEqual(f.kernel.links, []);
  assert.deepEqual(f.kernel.routes, []);
  assert.deepEqual(f.kernel.rules, []);
});

test("each failed mutation rolls back while unrelated rules routes and links survive", async (t) => {
  const reference = await fixture(t);
  await setupNetwork(reference.manifest, reference.config, reference.deps);
  for (let fail = 1; fail <= reference.kernel.mutations; fail++) {
    const k = new Kernel();
    k.failAt = fail;
    k.links.push({ ifname: "foreign", ifalias: "foreign" });
    k.rules.push({
      family: 4,
      priority: 10000,
      dst: "172.20.0.0/16",
      table: 20000,
      protocol: 99,
    });
    k.routes.push({
      family: 4,
      dst: "172.20.0.0/16",
      type: "unicast",
      table: 20000,
      dev: "foreign",
      protocol: 99,
    });
    const f = await fixture(t, k);
    await assert.rejects(
      setupNetwork(f.manifest, f.config, f.deps),
      /Injected/,
    );
    k.failAt = 0;
    await cleanupNetwork(f.manifest, f.deps);
    await cleanupNetwork(f.manifest, f.deps);
    assert.equal(k.links.length, 1);
    assert.equal(k.links[0].ifname, "foreign");
    assert.equal(k.rules.length, 1);
    assert.equal(k.routes.length, 1);
  }
});

test("cleanup refuses changed ownership rather than removing foreign state", async (t) => {
  const f = await fixture(t);
  await setupNetwork(f.manifest, f.config, f.deps);
  f.kernel.links[0].ifalias = "foreign";
  await assert.rejects(cleanupNetwork(f.manifest, f.deps), /ownership/);
  assert.equal(f.kernel.links.length, 1);
});

test("independent instances reserve different tables and rules", async (t) => {
  const k = new Kernel(),
    first = await fixture(t, k),
    second = await fixture(t, k);
  await setupNetwork(first.manifest, first.config, first.deps);
  await setupNetwork(second.manifest, second.config, second.deps);
  assert.notEqual(
    (await readManifest(first.manifest)).network.table,
    (await readManifest(second.manifest)).network.table,
  );
  await cleanupNetwork(first.manifest, first.deps);
  assert.equal(k.links.length, 1);
  await cleanupNetwork(second.manifest, second.deps);
  assert.equal(k.links.length, 0);
});

test("failed rule cleanup retains terminal defaults so remaining private rules cannot fall through", async (t) => {
  const f = await fixture(t);
  await setupNetwork(f.manifest, f.config, f.deps);
  f.kernel.failAt = f.kernel.mutations + 2;
  await assert.rejects(cleanupNetwork(f.manifest, f.deps), /cleanup failed/);
  assert.equal(
    f.kernel.routes.filter(
      (r) => r.dst === "default" && r.type === "unreachable",
    ).length,
    2,
  );
  f.kernel.failAt = 0;
  await cleanupNetwork(f.manifest, f.deps);
});
module.exports = { Kernel, fixture };

test("failure blocking refuses to replace a foreign route", async (t) => {
  const f = await fixture(t);
  await setupNetwork(f.manifest, f.config, f.deps);
  const route = f.kernel.routes.find((r) => r.dst === "10.42.0.0/16");
  route.protocol = 99;
  route.dev = "foreign";
  const foreign = { ...route };
  await assert.rejects(blockNetwork(f.manifest, f.deps), /ownership/);
  assert.deepEqual(route, foreign);
  assert.ok(
    f.kernel.routes.some(
      (r) => r.dst === "default" && r.type === "unreachable",
    ),
  );
});

test("interrupted failure blocking remains safely cleanable", async (t) => {
  const f = await fixture(t);
  await setupNetwork(f.manifest, f.config, f.deps);
  f.kernel.failAt = f.kernel.mutations + 1;
  await assert.rejects(blockNetwork(f.manifest, f.deps), /Injected/);
  f.kernel.failAt = 0;
  await cleanupNetwork(f.manifest, f.deps);
  assert.deepEqual(f.kernel.routes, []);
  assert.deepEqual(f.kernel.rules, []);
  assert.deepEqual(f.kernel.links, []);
});
