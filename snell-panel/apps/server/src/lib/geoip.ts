export interface GeoInfo {
  countryCode: string | null;
  isp: string | null;
  asn: number | null;
}

const EMPTY: GeoInfo = { countryCode: null, isp: null, asn: null };
const UA = "Mozilla/5.0 (compatible; snell-panel)";

/**
 * Best-effort geolocation for a host (IP or domain). Resolves domains to an A
 * record via DoH first, then tries ip.sb, falling back to ipinfo.es. Returns
 * blank fields on total failure — geo data is never required.
 */
export async function lookupGeo(host: string): Promise<GeoInfo> {
  const ip = await resolveToIp(host);
  if (!ip) return EMPTY;

  const primary = await safe(() => fromIpSb(ip));
  if (hasData(primary)) return primary!;

  const fallback = await safe(() => fromIpInfoEs(ip));
  if (hasData(fallback)) return fallback!;

  return primary ?? fallback ?? EMPTY;
}

// --- sources --------------------------------------------------------------

// Primary: https://api.ip.sb/geoip/<ip> → { country_code, isp, asn:number, ... }
async function fromIpSb(ip: string): Promise<GeoInfo> {
  const res = await fetch(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return EMPTY;
  const d = (await res.json()) as Record<string, unknown>;
  return {
    countryCode: str(d.country_code),
    isp: str(d.isp) ?? str(d.asn_organization) ?? str(d.organization),
    asn: toAsn(d.asn),
  };
}

// Fallback: https://api.ipinfo.es/ipinfo?ip=<ip> → { country, as_name, asn:"AS15169", ... }
async function fromIpInfoEs(ip: string): Promise<GeoInfo> {
  const res = await fetch(`https://api.ipinfo.es/ipinfo?ip=${encodeURIComponent(ip)}`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return EMPTY;
  const d = (await res.json()) as Record<string, unknown>;
  return {
    countryCode: str(d.country),
    isp: str(d.as_name) ?? str(d.as_domain),
    asn: toAsn(d.asn),
  };
}

// --- host resolution ------------------------------------------------------

async function resolveToIp(host: string): Promise<string | null> {
  const h = host.trim();
  if (!h) return null;
  if (isIpLiteral(h)) return h;

  // Resolve the domain to an A record via DoH; if it fails, hand the hostname
  // to the geo API directly (it may still resolve it).
  const data = await safe(async () => {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`,
      { headers: { accept: "application/dns-json" } },
    );
    if (!r.ok) return null;
    return (await r.json()) as { Answer?: Array<{ type: number; data: string }> };
  });

  const answer = data?.Answer?.find((a) => a.type === 1);
  return answer?.data ?? h;
}

function isIpLiteral(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
}

// --- helpers --------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Accepts 15169 or "AS15169" → 15169. */
function toAsn(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const m = v.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

function hasData(g: GeoInfo | null): boolean {
  return !!g && (g.countryCode !== null || g.isp !== null || g.asn !== null);
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}
