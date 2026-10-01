"use strict";
const { isIP } = require("node:net");
function parseIp(text) {
  if (typeof text !== "string" || text.includes("%"))
    throw new Error(`Invalid IP address: ${text}`);
  const family = isIP(text);
  if (!family) throw new Error(`Invalid IP address: ${text}`);
  if (family === 4) {
    const octets = text.split(".").map(Number);
    return {
      family,
      bits: octets.reduce((n, b) => (n << 8n) | BigInt(b), 0n),
      canonical: octets.join("."),
    };
  }
  if (text.includes(".")) throw new Error("IPv4-mapped IPv6 is not supported");
  const halves = text.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  const bits = words.reduce((n, w) => (n << 16n) | BigInt(`0x${w}`), 0n);
  if (bits >> 32n === 0xffffn)
    throw new Error("IPv4-mapped IPv6 is not supported");
  return { family, bits, canonical: formatIp(6, bits) };
}
function formatIp(family, bits) {
  if (family === 4)
    return [24n, 16n, 8n, 0n].map((n) => Number((bits >> n) & 255n)).join(".");
  const words = Array.from({ length: 8 }, (_, i) =>
    Number((bits >> BigInt((7 - i) * 16)) & 65535n).toString(16),
  );
  let bestStart = -1,
    bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (words[i] !== "0") {
      i++;
      continue;
    }
    let end = i;
    while (end < 8 && words[end] === "0") end++;
    if (end - i > bestLength) {
      bestStart = i;
      bestLength = end - i;
    }
    i = end;
  }
  if (bestStart < 0) return words.join(":");
  return `${words.slice(0, bestStart).join(":")}::${words.slice(bestStart + bestLength).join(":")}`;
}
function parseCidr(text) {
  const parts = text.split("/");
  if (parts.length !== 2 || !/^\d+$/.test(parts[1]))
    throw new Error(`Invalid CIDR: ${text}`);
  const ip = parseIp(parts[0]),
    width = ip.family === 4 ? 32 : 128,
    prefix = Number(parts[1]);
  if (prefix > width) throw new Error(`Invalid CIDR prefix: ${text}`);
  const shift = BigInt(width - prefix),
    bits = (ip.bits >> shift) << shift;
  return {
    family: ip.family,
    bits,
    prefix,
    canonical: `${formatIp(ip.family, bits)}/${prefix}`,
  };
}
function contains(cidr, ip) {
  return (
    cidr.family === ip.family &&
    cidr.bits ===
      (ip.bits >> BigInt((ip.family === 4 ? 32 : 128) - cidr.prefix)) <<
        BigInt((ip.family === 4 ? 32 : 128) - cidr.prefix)
  );
}
function overlaps(a, b) {
  return a.family === b.family && (contains(a, b) || contains(b, a));
}
module.exports = { parseIp, parseCidr, contains, overlaps };
