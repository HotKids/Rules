/** Mask a host for privacy mode: keep the first segment, replace the rest with ***. */
export function maskHost(host: string): string {
  if (host.includes(":")) return `${host.split(":")[0]}:***`; // IPv6
  const i = host.indexOf(".");
  return i === -1 ? `${host.slice(0, 2)}***` : `${host.slice(0, i)}.***`;
}

/** Render "ip:port", masking both when privacy mode is on. */
export function addrText(
  ip: string | null,
  port: number | null,
  privacy: boolean,
): string {
  if (!ip) return "—";
  const h = privacy ? maskHost(ip) : ip;
  if (!port) return h;
  return `${h}:${privacy ? "***" : port}`;
}

/** Country code (e.g. "JP") → flag emoji 🇯🇵. Empty string when unknown. */
export function countryFlag(cc: string | null | undefined): string {
  if (!cc || cc.length !== 2) return "";
  const base = 0x1f1e6; // regional indicator 'A'
  let out = "";
  for (const ch of cc.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return "";
    out += String.fromCodePoint(base + (code - 65));
  }
  return out;
}
