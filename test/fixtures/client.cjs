"use strict";
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
if (args.includes("capabilities")) {
  console.log(
    JSON.stringify({
      schema: 1,
      features: [
        "proxy-http",
        "proxy-connect",
        "proxy-socks5",
        "proxy-socks5-udp",
        "proxy-ready-v1",
        "proxy-tun-v1",
      ],
    }),
  );
} else {
  const http = net.createServer((s) => s.end()),
    socks = net.createServer((s) => s.end());
  http.listen(0, "127.0.0.1", () =>
    socks.listen(0, "127.0.0.1", () => {
      if (!args.includes("--no-ready"))
        fs.writeFileSync(
          value("--ready-file"),
          JSON.stringify({
            schema: 1,
            tun_interface: args.includes("--tun-interface")
              ? args.includes("--wrong-tun")
                ? "skm-wrong"
                : value("--tun-interface")
              : null,
            pid: process.pid,
            http: `127.0.0.1:${http.address().port}`,
            socks: `127.0.0.1:${socks.address().port}`,
            gateway: args.includes("--wrong-gateway")
              ? "192.0.2.99:443"
              : value("--proxy"),
          }),
        );
      if (args.includes("--exit-after-ready"))
        setTimeout(() => process.exit(2), 600);
    }),
  );
}
