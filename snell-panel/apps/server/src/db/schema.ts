import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

/** A Snell node. Created as a draft (status='pending'), then back-filled by the
 *  provisioner callback (status='active'). */
export const nodes = sqliteTable(
  "nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: text("node_id").notNull().unique(),
    nodeName: text("node_name").notNull(),
    /** 'snell' | 'ss2022' */
    protocol: text("protocol").notNull().default("snell"),
    /** Snell: '5' | '6'; SS2022: '2022' */
    version: text("version").notNull(),
    /** SS2022 cipher method; null for Snell. */
    method: text("method"),
    /** 'pending' | 'installing' | 'active' | 'failed' | 'upgrading' | 'disabled' */
    status: text("status").notNull().default("pending"),
    ip: text("ip"),
    port: integer("port"),
    psk: text("psk"),
    countryCode: text("country_code"),
    isp: text("isp"),
    asn: integer("asn"),
    tfo: integer("tfo", { mode: "boolean" }).notNull().default(true),
    /** When false, the node is hidden from subscriptions but still exists. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ipPrefilled: integer("ip_prefilled", { mode: "boolean" }).notNull().default(false),
    portPrefilled: integer("port_prefilled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    registeredAt: integer("registered_at"),
    installStartedAt: integer("install_started_at"),
    installFinishedAt: integer("install_finished_at"),
    lastError: text("last_error"),
    lastSeenAt: integer("last_seen_at"),
    lastCheckAt: integer("last_check_at"),
    vendor: text("vendor"),
    region: text("region"),
    tags: text("tags").notNull().default("[]"),
    expireAt: integer("expire_at"),
    remark: text("remark"),
  },
  (t) => ({
    protocolIdx: index("nodes_protocol_idx").on(t.protocol),
    statusIdx: index("nodes_status_idx").on(t.status),
    vendorIdx: index("nodes_vendor_idx").on(t.vendor),
    regionIdx: index("nodes_region_idx").on(t.region),
    expireIdx: index("nodes_expire_idx").on(t.expireAt),
  }),
);

/** Per-node, single-use, expiring tokens embedded in provision/upgrade commands. */
export const installTokens = sqliteTable(
  "install_tokens",
  {
    token: text("token").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.nodeId, { onDelete: "cascade" }),
    /** 'install' | 'upgrade' | 'uninstall' | 'heartbeat' */
    purpose: text("purpose").notNull().default("install"),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (t) => ({
    nodeIdx: index("install_tokens_node_idx").on(t.nodeId),
  }),
);

/** Simple key/value settings (e.g. the rotatable subscribe token). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type NodeRow = typeof nodes.$inferSelect;
export type NodeInsert = typeof nodes.$inferInsert;
export type InstallTokenRow = typeof installTokens.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
