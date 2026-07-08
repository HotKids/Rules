import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  Enums / constants                                                         */
/* -------------------------------------------------------------------------- */

/** Protocol families the panel can provision. */
export const NODE_PROTOCOLS = ["snell", "ss2022"] as const;
export type NodeProtocol = (typeof NODE_PROTOCOLS)[number];

/** Snell protocol versions the panel can install. V5 and V6 only. */
export const SNELL_VERSIONS = ["5", "6"] as const;
export type SnellVersion = (typeof SNELL_VERSIONS)[number];

/** Shadowsocks 2022 methods mirrored from the jinqians SS2022 installer. */
export const SS2022_METHODS = [
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "2022-blake3-chacha8-poly1305",
] as const;
export type SS2022Method = (typeof SS2022_METHODS)[number];
export const DEFAULT_SS2022_METHOD: SS2022Method = "2022-blake3-aes-128-gcm";

export const NODE_VERSIONS = [...SNELL_VERSIONS, "2022"] as const;
export type NodeVersion = (typeof NODE_VERSIONS)[number];

/** Lifecycle of a node row. */
export const NODE_STATUSES = ["pending", "installing", "active", "failed", "upgrading", "disabled"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** Subscription output formats. */
export const SUBSCRIPTION_FORMATS = ["surge", "shadowrocket", "mihomo", "loon", "stash", "sing-box", "mihomo-provider"] as const;
export type SubscriptionFormat = (typeof SUBSCRIPTION_FORMATS)[number];

/* -------------------------------------------------------------------------- */
/*  Node DTO (shape returned by the API)                                      */
/* -------------------------------------------------------------------------- */

export interface NodeDTO {
  id: number;
  node_id: string;
  node_name: string;
  protocol: NodeProtocol;
  version: NodeVersion;
  method: SS2022Method | null;
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
  install_started_at: number | null;
  install_finished_at: number | null;
  last_seen_at: number | null;
  last_check_at: number | null;
  last_error: string | null;
  vendor: string | null;
  region: string | null;
  tags: string[];
  expire_at: number | null;
  remark: string | null;
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

const nodeProtocolSchema = z.enum(NODE_PROTOCOLS);
const nodeVersionSchema = z.enum(NODE_VERSIONS);
const ss2022MethodSchema = z.enum(SS2022_METHODS);

/** POST /api/nodes — create a pending (draft) node. */
export const createNodeSchema = z
  .object({
    protocol: nodeProtocolSchema.optional().default("snell"),
    version: nodeVersionSchema.optional(),
    method: ss2022MethodSchema.optional(),
    node_name: z.string().trim().min(1).max(64),
    /** Optional pre-fill: if present, install MUST use this address. */
    ip: hostSchema.optional(),
    /** Optional pre-fill: if present, install MUST listen on this port. */
    port: portSchema.optional(),
    tfo: z.boolean().optional().default(true),
    vendor: z.string().trim().max(64).optional(),
    region: z.string().trim().max(64).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).optional(),
    expire_at: z.coerce.number().int().positive().optional(),
    remark: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.protocol === "snell") {
      if (v.version !== undefined && !(SNELL_VERSIONS as readonly string[]).includes(v.version)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["version"],
          message: "Snell nodes must use version 5 or 6",
        });
      }
      return;
    }

    if (v.version !== undefined && v.version !== "2022") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: "SS2022 nodes must use version 2022",
      });
    }
  });
export type CreateNodeInput = z.infer<typeof createNodeSchema>;

/** PATCH /api/nodes/:id — rename, repoint, or enable/disable a node. */
export const patchNodeSchema = z
  .object({
    node_name: z.string().trim().min(1).max(64).optional(),
    ip: hostSchema.optional(),
    enabled: z.boolean().optional(),
    vendor: z.string().trim().max(64).nullable().optional(),
    region: z.string().trim().max(64).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).optional(),
    expire_at: z.coerce.number().int().positive().nullable().optional(),
    remark: z.string().trim().max(500).nullable().optional(),
  })
  .refine(
    (v) =>
      v.node_name !== undefined || v.ip !== undefined || v.enabled !== undefined || v.vendor !== undefined || v.region !== undefined || v.tags !== undefined || v.expire_at !== undefined || v.remark !== undefined,
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

/** POST /api/nodes/:id/register — server-side callback from the provisioner. */
export const registerNodeSchema = z
  .object({
    protocol: nodeProtocolSchema.optional(),
    ip: hostSchema.optional(),
    port: portSchema,
    psk: z.string().min(1).max(255),
    version: nodeVersionSchema,
    method: ss2022MethodSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const protocol = v.protocol ?? (v.version === "2022" ? "ss2022" : "snell");
    if (protocol === "ss2022" && v.method === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "SS2022 register callbacks must include method",
      });
    }
    if (protocol === "snell" && !(SNELL_VERSIONS as readonly string[]).includes(v.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["version"],
        message: "Snell register callbacks must use version 5 or 6",
      });
    }
  });
export type RegisterNodeInput = z.infer<typeof registerNodeSchema>;


export const installFailedSchema = z.object({
  error: z.string().trim().min(1).max(2000),
});
export type InstallFailedInput = z.infer<typeof installFailedSchema>;

export const heartbeatSchema = z.object({
  service_active: z.boolean(),
  version: z.string().trim().max(64).optional(),
  port: portSchema.optional(),
  uptime: z.coerce.number().int().nonnegative().optional(),
  ip: hostSchema.optional(),
  error: z.string().trim().max(2000).optional(),
});
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;

/* -------------------------------------------------------------------------- */
/*  Response shapes                                                           */
/* -------------------------------------------------------------------------- */

export interface InstallCommandResponse {
  /** The full copy-paste provisioning command to run on the server. */
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
