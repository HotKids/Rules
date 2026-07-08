import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  Enums / constants                                                         */
/* -------------------------------------------------------------------------- */

/** Snell protocol versions the panel can install. V5 and V6 only. */
export const SNELL_VERSIONS = ["5", "6"] as const;
export type SnellVersion = (typeof SNELL_VERSIONS)[number];

/** Lifecycle of a node row. */
export const NODE_STATUSES = ["pending", "active"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Subscription output formats. */
export const SUBSCRIPTION_FORMATS = ["surge", "shadowrocket", "mihomo"] as const;
export type SubscriptionFormat = (typeof SUBSCRIPTION_FORMATS)[number];

/* -------------------------------------------------------------------------- */
/*  Node DTO (shape returned by the API)                                      */
/* -------------------------------------------------------------------------- */

export interface NodeDTO {
  id: number;
  node_id: string;
  node_name: string;
  version: SnellVersion;
  status: NodeStatus;
  ip: string | null;
  port: number | null;
  /** PSK is only exposed to the authenticated admin panel. */
  psk: string | null;
  country_code: string | null;
  isp: string | null;
  asn: number | null;
  tfo: boolean;
  /** When false, the node is hidden from subscriptions but still exists. */
  enabled: boolean;
  ip_prefilled: boolean;
  port_prefilled: boolean;
  created_at: number;
  registered_at: number | null;
}

/* -------------------------------------------------------------------------- */
/*  Request schemas                                                           */
/* -------------------------------------------------------------------------- */

const hostSchema = z
  .string()
  .trim()
  .min(1, "host must not be empty")
  .max(253, "host too long");

const portSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535);

/** POST /api/nodes — create a pending (draft) node. */
export const createNodeSchema = z.object({
  version: z.enum(SNELL_VERSIONS),
  node_name: z.string().trim().min(1).max(64),
  /** Optional pre-fill: if present, install MUST use this address. */
  ip: hostSchema.optional(),
  /** Optional pre-fill: if present, install MUST listen on this port. */
  port: portSchema.optional(),
  tfo: z.boolean().optional().default(true),
});
export type CreateNodeInput = z.infer<typeof createNodeSchema>;

/** PATCH /api/nodes/:id — rename, repoint, or enable/disable a node. */
export const patchNodeSchema = z
  .object({
    node_name: z.string().trim().min(1).max(64).optional(),
    ip: hostSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.node_name !== undefined || v.ip !== undefined || v.enabled !== undefined,
    { message: "nothing to update" },
  );
export type PatchNodeInput = z.infer<typeof patchNodeSchema>;

/** POST /api/nodes/:id/relay — clone an active node behind a new IP/port (transit). */
export const relayNodeSchema = z.object({
  node_name: z.string().trim().min(1).max(64),
  ip: hostSchema,
  port: portSchema,
});
export type RelayNodeInput = z.infer<typeof relayNodeSchema>;

/** POST /api/nodes/:id/register — server-side callback from the installer. */
export const registerNodeSchema = z.object({
  ip: hostSchema.optional(),
  port: portSchema,
  psk: z.string().min(1).max(255),
  version: z.enum(SNELL_VERSIONS),
});
export type RegisterNodeInput = z.infer<typeof registerNodeSchema>;

/* -------------------------------------------------------------------------- */
/*  Response shapes                                                           */
/* -------------------------------------------------------------------------- */

export interface InstallCommandResponse {
  /** The full copy-paste command to run on the server. */
  command: string;
  /** The one-time token embedded in the command (also shown for reference). */
  token: string;
  /** Unix seconds when the token expires. */
  expires_at: number;
  /** 'install' | 'upgrade' */
  purpose: "install" | "upgrade";
}

export interface SnellVersionsResponse {
  /** Exact "latest" build per family, e.g. "v5.0.1" / "v6.0.0b4". */
  v5: string;
  v6: string;
}

export interface SettingsResponse {
  /** Rotatable token embedded in subscription URLs (independent of ACCESS_TOKEN). */
  subscribe_token: string;
}

export interface ApiError {
  error: string;
}
