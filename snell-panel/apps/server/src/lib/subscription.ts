import {
  DEFAULT_SS2022_METHOD,
  type NodeProtocol,
  type SS2022Method,
  type SubscriptionFormat,
} from "@snell-panel/shared";
import type { NodeRow } from "../db/schema";

const SHADOWROCKET_METHOD = "chacha20-ietf-poly1305";

export interface SubscriptionOptions {
  format: SubscriptionFormat;
  via?: string;
  showFlag: boolean;
}

/** Render active nodes into a subscription document for the given format. */
export function renderSubscription(nodes: NodeRow[], opts: SubscriptionOptions): string {
  // Relay (underlying-proxy / dialer-proxy) is a Surge-only concept, so drop
  // `via` for the other formats — no relay is emitted for Shadowrocket/Mihomo.
  const o: SubscriptionOptions =
    opts.format === "surge" ? opts : { ...opts, via: undefined };
  const lines: string[] = [];
  for (const n of nodes) {
    // Skip disabled nodes and nodes not yet registered (no ip/port/psk).
    if (!n.enabled) continue;
    if (!n.ip || !n.port || !n.psk) continue;
    const name = composeNodeName(n, o);
    lines.push(formatLine(n, name, o));
  }
  if (["mihomo", "stash", "mihomo-provider"].includes(o.format)) return "proxies:\n" + lines.join("\n");
  if (o.format === "sing-box") return JSON.stringify({ outbounds: lines.map((line) => JSON.parse(line)) }, null, 2);
  return lines.join("\n");
}

function composeNodeName(n: NodeRow, opts: SubscriptionOptions): string {
  const flag = countryCodeToFlagEmoji(n.countryCode ?? "");
  let name: string;
  if (!n.nodeName) {
    const base = `${n.countryCode ?? ""} AS${n.asn ?? 0} ${n.isp ?? ""} ${n.nodeId}`;
    name = opts.showFlag ? `${flag} ${base}` : base;
  } else {
    name = opts.showFlag ? `${flag} ${n.nodeName}` : n.nodeName;
  }
  if (opts.via) name = `${name} - ${opts.via}`;
  return name;
}

function formatLine(n: NodeRow, name: string, opts: SubscriptionOptions): string {
  switch (opts.format) {
    case "shadowrocket":
      return formatShadowrocket(n, name);
    case "mihomo":
    case "stash":
    case "mihomo-provider":
      return formatMihomo(n, name, opts.via);
    case "loon":
      return formatSurge(n, name, opts.via);
    case "sing-box":
      return formatSingBox(n, name);
    default:
      return formatSurge(n, name, opts.via);
  }
}

function formatSurge(n: NodeRow, name: string, via?: string): string {
  if (nodeProtocol(n) === "ss2022") {
    const method = ss2022Method(n);
    let line = `${name} = ss, ${n.ip}, ${n.port}, encrypt-method=${method}, password=${n.psk}, tfo=${n.tfo ? "true" : "false"}, udp-relay=true`;
    if (via) line += `, underlying-proxy = ${via}`;
    return line;
  }

  let line = via
    ? `${name} = snell, ${n.ip}, ${n.port}, psk = ${n.psk}, version = ${n.version}, underlying-proxy = ${via}`
    : `${name} = snell, ${n.ip}, ${n.port}, psk = ${n.psk}, version = ${n.version}`;
  if (n.tfo) line += ", tfo = true";
  return line;
}

function formatShadowrocket(n: NodeRow, name: string): string {
  if (nodeProtocol(n) === "ss2022") {
    const server = joinHostPort(n.ip!, n.port!);
    const encoded = base64UrlNoPad(`${ss2022Method(n)}:${n.psk}@${server}`);
    let line = `ss://${encoded}`;
    if (name) line += `#${encodeURIComponent(name)}`;
    return line;
  }

  const server = joinHostPort(n.ip!, n.port!);
  const encoded = base64RawStd(`${SHADOWROCKET_METHOD}:${n.psk}@${server}`);
  const params = new URLSearchParams();
  params.set("tfo", n.tfo ? "1" : "0");
  params.set("version", n.version);
  let line = `snell://${encoded}?${params.toString()}`;
  if (name) line += `#${encodeURIComponent(name)}`;
  return line;
}

function formatMihomo(n: NodeRow, name: string, via?: string): string {
  if (nodeProtocol(n) === "ss2022") {
    const fields = [
      `name: ${yamlFlow(name)}`,
      `server: ${yamlFlow(n.ip!)}`,
      `port: ${n.port}`,
      "type: ss",
      `cipher: ${yamlFlow(ss2022Method(n))}`,
      `password: ${yamlFlow(n.psk!)}`,
      "udp: true",
    ];
    if (n.tfo) fields.push("tfo: true");
    if (via) fields.push(`dialer-proxy: ${yamlFlow(via)}`);
    return "  - {" + fields.join(", ") + "}";
  }

  const fields = [
    `name: ${yamlFlow(name)}`,
    `server: ${yamlFlow(n.ip!)}`,
    `port: ${n.port}`,
    "type: snell",
    `psk: ${yamlFlow(n.psk!)}`,
  ];
  if (/^\d+$/.test(n.version)) fields.push(`version: ${n.version}`);
  if (n.tfo) fields.push("tfo: true");
  if (via) fields.push(`dialer-proxy: ${yamlFlow(via)}`);
  return "  - {" + fields.join(", ") + "}";
}

function formatSingBox(n: NodeRow, name: string): string {
  if (nodeProtocol(n) === "ss2022") {
    return JSON.stringify({
      type: "shadowsocks",
      tag: name,
      server: n.ip,
      server_port: n.port,
      method: ss2022Method(n),
      password: n.psk,
    });
  }
  return JSON.stringify({
    type: "snell",
    tag: name,
    server: n.ip,
    server_port: n.port,
    version: Number(n.version),
    psk: n.psk,
  });
}

// --- helpers --------------------------------------------------------------

export function countryCodeToFlagEmoji(cc: string): string {
  if (cc.length !== 2) return cc;
  const base = 0x1f1e6; // regional indicator 'A'
  let out = "";
  for (const ch of cc.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return cc;
    out += String.fromCodePoint(base + (code - 65));
  }
  return out;
}

function joinHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function base64RawStd(s: string): string {
  // Standard base64 without padding (matches Go's base64.RawStdEncoding).
  return btoa(s).replace(/=+$/, "");
}

function base64UrlNoPad(s: string): string {
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function yamlFlow(value: string): string {
  // Double-quoted YAML flow scalar; JSON.stringify is a close analog of Go's strconv.Quote.
  return JSON.stringify(value);
}

function nodeProtocol(n: NodeRow): NodeProtocol {
  return (n.protocol ?? "snell") as NodeProtocol;
}

function ss2022Method(n: NodeRow): SS2022Method {
  return (n.method ?? DEFAULT_SS2022_METHOD) as SS2022Method;
}
