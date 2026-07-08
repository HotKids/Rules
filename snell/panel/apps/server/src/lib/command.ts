import type { SnellVersion } from "@snell-panel/shared";
import type { NodeRow } from "../db/schema";
import type { TokenPurpose } from "./token";

export interface CommandParams {
  /** Origin of this panel, e.g. https://panel.example.com (no trailing slash). */
  apiUrl: string;
  node: NodeRow;
  token: string;
  /** Target protocol family: install version, or the upgrade target (always '6'). */
  version: SnellVersion;
  /** Exact build string, e.g. v6.0.0b4. */
  snellVersion: string;
  purpose: TokenPurpose;
}

/** Build the copy-paste command shown in the panel's Install / Upgrade modal. */
export function buildCommand(p: CommandParams): string {
  const { apiUrl, node, token, version, snellVersion, purpose } = p;
  const args: string[] = [
    `bash <(curl -fsSL ${apiUrl}/install.sh) ${purpose}`,
    `--api-url ${apiUrl}`,
    `--node-id ${node.nodeId}`,
    `--token ${token}`,
    `--version ${version}`,
    `--snell-version ${snellVersion}`,
  ];

  if (purpose === "install") {
    // Pre-filled IP/Port must be honored verbatim by the installer.
    // The node name is panel-authoritative (set at creation, never overwritten
    // by register), so it is intentionally NOT passed to the installer.
    if (node.ipPrefilled && node.ip) args.push(`--ip ${node.ip}`);
    if (node.portPrefilled && node.port) args.push(`--port ${node.port}`);
  }

  // One line — easier to paste; no backslash continuations.
  return args.join(" ");
}
