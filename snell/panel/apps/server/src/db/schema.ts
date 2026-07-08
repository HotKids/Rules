import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";

/** A Snell node. Created as a draft (status='pending'), then back-filled by the
 *  installer callback (status='active'). */
export const nodes = sqliteTable(
  "nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: text("node_id").notNull().unique(),
    nodeName: text("node_name").notNull(),
    /** '5' | '6' */
    version: text("version").notNull(),
    /** 'pending' | 'active' */
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
  },
  (t) => ({
    statusIdx: index("nodes_status_idx").on(t.status),
  }),
);

/** Per-node, single-use, expiring tokens embedded in install/upgrade commands. */
export const installTokens = sqliteTable(
  "install_tokens",
  {
    token: text("token").primaryKey(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.nodeId, { onDelete: "cascade" }),
    /** 'install' | 'upgrade' */
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
