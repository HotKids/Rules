import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, like } from "drizzle-orm";
import {
  DEFAULT_SS2022_METHOD,
  createNodeSchema,
  patchNodeSchema,
  relayNodeSchema,
  type NodeProtocol,
  type NodeVersion,
  type SnellVersion,
} from "@snell-panel/shared";
import { installTokens, nodes, type NodeInsert } from "../db/schema";
import type { AppEnv } from "../env";
import { requireAccess, requireAccessOrApiToken } from "../middleware/auth";
import { toNodeDTO } from "../lib/dto";
import { mintToken } from "../lib/token";
import { getNode, nowSeconds as now } from "../lib/node-repo";
import { snellVersionFor } from "../lib/versions";
import { buildCommand } from "../lib/command";
import { lookupGeo } from "../lib/geoip";

const router = new Hono<AppEnv>();

// GET /api/nodes — list with structured filters and sorting.
router.get("/", requireAccess, async (c) => {
  const q = c.req.query();
  const filters = [];
  if (q.vendor) filters.push(eq(nodes.vendor, q.vendor));
  if (q.region) filters.push(eq(nodes.region, q.region));
  if (q.protocol) filters.push(eq(nodes.protocol, q.protocol));
  if (q.status) filters.push(eq(nodes.status, q.status));
  if (q.enabled === "true" || q.enabled === "false") filters.push(eq(nodes.enabled, q.enabled === "true"));
  if (q.tag) filters.push(like(nodes.tags, `%"${q.tag}"%`));

  const sort = q.sort;
  const sortColumn = sort === "registered_at" ? nodes.registeredAt : sort === "expire_at" ? nodes.expireAt : nodes.createdAt;
  const order = q.order === "asc" ? asc(sortColumn) : desc(sortColumn);
  const query = c.get("db").select().from(nodes).where(filters.length ? and(...filters) : undefined).orderBy(order);
  const rows = await query;
  return c.json({ nodes: rows.map(toNodeDTO) });
});

// POST /api/nodes — create a pending (draft) node
router.post("/", requireAccess, zValidator("json", createNodeSchema), async (c) => {
  const db = c.get("db");
  const input = c.req.valid("json");

  const geo = input.ip
    ? await lookupGeo(input.ip)
    : { countryCode: null, isp: null, asn: null };
  const protocol: NodeProtocol = input.protocol;
  const version: NodeVersion =
    protocol === "ss2022" ? "2022" : ((input.version ?? "6") as SnellVersion);
  const method = protocol === "ss2022" ? input.method ?? DEFAULT_SS2022_METHOD : null;

  const values: NodeInsert = {
    nodeId: crypto.randomUUID(),
    nodeName: input.node_name,
    protocol,
    version,
    method,
    status: "pending",
    ip: input.ip ?? null,
    port: input.port ?? null,
    psk: null,
    countryCode: geo.countryCode,
    isp: geo.isp,
    asn: geo.asn,
    tfo: input.tfo,
    ipPrefilled: input.ip !== undefined,
    portPrefilled: input.port !== undefined,
    createdAt: now(),
    registeredAt: null,
    installStartedAt: null,
    installFinishedAt: null,
    lastError: null,
    lastSeenAt: null,
    lastCheckAt: null,
    vendor: input.vendor || null,
    region: input.region || null,
    tags: JSON.stringify(input.tags ?? []),
    expireAt: input.expire_at ?? null,
    remark: input.remark || null,
  };

  const inserted = await db.insert(nodes).values(values).returning();
  return c.json({ node: toNodeDTO(inserted[0]) }, 201);
});

// POST /api/nodes/:id/relay — clone an active node behind a new IP/port (transit)
router.post("/:id/relay", requireAccess, zValidator("json", relayNodeSchema), async (c) => {
  const db = c.get("db");
  const origin = await getNode(db, c.req.param("id"));
  if (!origin) return c.json({ error: "Node not found" }, 404);
  if (!origin.psk) {
    return c.json({ error: "Origin node has no PSK yet; install it before adding a relay" }, 400);
  }
  const input = c.req.valid("json");
  const geo = await lookupGeo(input.ip);
  const ts = now();

  const values: NodeInsert = {
    nodeId: crypto.randomUUID(),
    nodeName: input.node_name,
    protocol: (origin.protocol ?? "snell") as NodeProtocol,
    version: origin.version,
    method: origin.method,
    status: "active", // PSK is known (copied), so no install step is needed
    ip: input.ip,
    port: input.port,
    psk: origin.psk,
    countryCode: geo.countryCode,
    isp: geo.isp,
    asn: geo.asn,
    tfo: origin.tfo,
    ipPrefilled: true,
    portPrefilled: true,
    createdAt: ts,
    registeredAt: ts,
    installStartedAt: ts,
    installFinishedAt: ts,
    lastSeenAt: ts,
    lastCheckAt: null,
    lastError: null,
    vendor: origin.vendor,
    region: origin.region,
    tags: origin.tags,
    expireAt: origin.expireAt,
    remark: origin.remark,
  };
  const inserted = await db.insert(nodes).values(values).returning();
  return c.json({ node: toNodeDTO(inserted[0]) }, 201);
});

// GET /api/nodes/:id/install — mint a one-time token + build the provisioning command
router.get("/:id/install", requireAccess, async (c) => {
  const db = c.get("db");
  const row = await getNode(db, c.req.param("id"));
  if (!row) return c.json({ error: "Node not found" }, 404);

  const protocol = (row.protocol ?? "snell") as NodeProtocol;
  const version = (protocol === "ss2022" ? "2022" : row.version) as NodeVersion;
  const { token, expiresAt } = await mintToken(db, row.nodeId, "install", now());
  const command = buildCommand({
    apiUrl: new URL(c.req.url).origin,
    node: row,
    token,
    version,
    snellVersion:
      protocol === "snell" ? snellVersionFor(c.env, version as SnellVersion) : undefined,
    purpose: "install",
  });
  return c.json({ command, token, expires_at: expiresAt, purpose: "install" });
});

// GET /api/nodes/:id/upgrade — mint a one-time token + build the V6 upgrade command
router.get("/:id/upgrade", requireAccess, async (c) => {
  const db = c.get("db");
  const row = await getNode(db, c.req.param("id"));
  if (!row) return c.json({ error: "Node not found" }, 404);
  if ((row.protocol ?? "snell") !== "snell") {
    return c.json({ error: "Only Snell nodes can be upgraded to V6" }, 400);
  }

  const { token, expiresAt } = await mintToken(db, row.nodeId, "upgrade", now());
  const command = buildCommand({
    apiUrl: new URL(c.req.url).origin,
    node: row,
    token,
    version: "6", // upgrade always targets V6
    snellVersion: snellVersionFor(c.env, "6"),
    purpose: "upgrade",
  });
  return c.json({ command, token, expires_at: expiresAt, purpose: "upgrade" });
});

// PATCH /api/nodes/:id — rename / repoint
router.patch("/:id", requireAccess, zValidator("json", patchNodeSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const input = c.req.valid("json");
  if (!(await getNode(db, id))) return c.json({ error: "Node not found" }, 404);

  const update: Partial<NodeInsert> = {};
  if (input.node_name !== undefined) update.nodeName = input.node_name;
  if (input.enabled !== undefined) update.enabled = input.enabled;
  if (input.ip !== undefined) {
    update.ip = input.ip;
    // An explicit admin repoint is authoritative — pin it so later node-reported
    // heartbeats can't silently overwrite it (mirrors create/relay semantics).
    update.ipPrefilled = true;
    const geo = await lookupGeo(input.ip);
    update.countryCode = geo.countryCode;
    update.isp = geo.isp;
    update.asn = geo.asn;
  }
  if (input.vendor !== undefined) update.vendor = input.vendor || null;
  if (input.region !== undefined) update.region = input.region || null;
  if (input.tags !== undefined) update.tags = JSON.stringify(input.tags);
  if (input.expire_at !== undefined) update.expireAt = input.expire_at;
  if (input.remark !== undefined) update.remark = input.remark || null;

  await db.update(nodes).set(update).where(eq(nodes.nodeId, id));
  const updated = await getNode(db, id);
  return c.json({ node: toNodeDTO(updated!) });
});

// DELETE /api/nodes/:id — panel (ACCESS) or provisioner uninstall (API_TOKEN)
router.delete("/:id", requireAccessOrApiToken, async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  // D1 does not enforce FKs by default, so clear tokens explicitly.
  await db.delete(installTokens).where(eq(installTokens.nodeId, id));
  const deleted = await db
    .delete(nodes)
    .where(eq(nodes.nodeId, id))
    .returning({ nodeId: nodes.nodeId });
  if (deleted.length === 0) return c.json({ error: "Node not found" }, 404);
  return c.json({ ok: true });
});

export default router;
