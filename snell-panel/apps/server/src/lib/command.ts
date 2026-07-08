import {
  DEFAULT_SS2022_METHOD,
  type NodeProtocol,
  type NodeVersion,
  type SS2022Method,
} from "@snell-panel/shared";
import type { NodeRow } from "../db/schema";
import type { TokenPurpose } from "./token";

export interface CommandParams {
  /** Origin of this panel, e.g. https://panel.example.com (no trailing slash). */
  apiUrl: string;
  node: NodeRow;
  token: string;
  /** Target protocol family: install version, or the upgrade target (always '6'). */
  version: NodeVersion;
  /** Exact build string, e.g. v6.0.0b4. */
  snellVersion?: string;
  purpose: TokenPurpose;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Build the copy-paste command shown in the panel's Provision / Upgrade modal. */
export function buildCommand(p: CommandParams): string {
  const { apiUrl, node, token, version, snellVersion, purpose } = p;
  const protocol = (node.protocol ?? "snell") as NodeProtocol;
  const method = (node.method ?? DEFAULT_SS2022_METHOD) as SS2022Method;
  const args: string[] = [
    `bash <(curl -fsSL ${shellArg(`${apiUrl}/install.sh`)}) ${purpose}`,
    `--api-url ${shellArg(apiUrl)}`,
    `--node-id ${shellArg(node.nodeId)}`,
    `--token ${shellArg(token)}`,
    `--protocol ${shellArg(protocol)}`,
    `--version ${shellArg(version)}`,
    `--name ${shellArg(node.nodeName)}`,
    `--tfo ${node.tfo ? "true" : "false"}`,
  ];

  if (protocol === "snell") {
    if (!snellVersion) throw new Error("snellVersion is required for Snell nodes");
    args.push(`--snell-version ${shellArg(snellVersion)}`);
  } else {
    args.push(`--method ${shellArg(method)}`);
  }

  if (purpose === "install") {
    // Pre-filled IP/Port must be honored verbatim by the provisioner.
    // The panel remains authoritative for the node name; --name is only used
    // for the VPS-side completion summary.
    if (node.ipPrefilled && node.ip) args.push(`--ip ${shellArg(node.ip)}`);
    if (node.portPrefilled && node.port) args.push(`--port ${shellArg(String(node.port))}`);
  }

  // One line — easier to paste; no backslash continuations.
  return args.join(" ");
}
