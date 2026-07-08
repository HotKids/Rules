import type { SubscriptionFormat } from "@snell-panel/shared";
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
  if (o.format === "mihomo") return "proxies:\n" + lines.join("\n");
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
      return formatMihomo(n, name, opts.via);
    default:
      return formatSurge(n, name, opts.via);
  }
}

function formatSurge(n: NodeRow, name: string, via?: string): string {
  let line = via
    ? `${name} = snell, ${n.ip}, ${n.port}, psk = ${n.psk}, version = ${n.version}, underlying-proxy = ${via}`
    : `${name} = snell, ${n.ip}, ${n.port}, psk = ${n.psk}, version = ${n.version}`;
  if (n.tfo) line += ", tfo = true";
  return line;
}

function formatShadowrocket(n: NodeRow, name: string): string {
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

function yamlFlow(value: string): string {
  // Double-quoted YAML flow scalar; JSON.stringify is a close analog of Go's strconv.Quote.
  return JSON.stringify(value);
}
