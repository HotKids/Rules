import type {
  NodeDTO,
  NodeProtocol,
  NodeStatus,
  NodeVersion,
  SS2022Method,
} from "@snell-panel/shared";
import type { NodeRow } from "../db/schema";

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const value = JSON.parse(tags) as unknown;
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export function toNodeDTO(n: NodeRow): NodeDTO {
  return {
    id: n.id,
    node_id: n.nodeId,
    node_name: n.nodeName,
    protocol: (n.protocol ?? "snell") as NodeProtocol,
    version: n.version as NodeVersion,
    method: n.method as SS2022Method | null,
    status: n.status as NodeStatus,
    ip: n.ip,
    port: n.port,
    psk: n.psk,
    country_code: n.countryCode,
    isp: n.isp,
    asn: n.asn,
    tfo: n.tfo,
    enabled: n.enabled,
    ip_prefilled: n.ipPrefilled,
    port_prefilled: n.portPrefilled,
    created_at: n.createdAt,
    registered_at: n.registeredAt,
    install_started_at: n.installStartedAt,
    install_finished_at: n.installFinishedAt,
    last_seen_at: n.lastSeenAt,
    last_check_at: n.lastCheckAt,
    last_error: n.lastError,
    vendor: n.vendor,
    region: n.region,
    tags: parseTags(n.tags),
    expire_at: n.expireAt,
    remark: n.remark,
  };
}
