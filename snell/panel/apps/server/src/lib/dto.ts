import type { NodeDTO, NodeStatus, SnellVersion } from "@snell-panel/shared";
import type { NodeRow } from "../db/schema";

export function toNodeDTO(n: NodeRow): NodeDTO {
  return {
    id: n.id,
    node_id: n.nodeId,
    node_name: n.nodeName,
    version: n.version as SnellVersion,
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
  };
}
