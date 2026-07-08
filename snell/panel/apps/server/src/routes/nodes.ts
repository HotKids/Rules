import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import {
  createNodeSchema,
  patchNodeSchema,
  relayNodeSchema,
  type SnellVersion,
} from "@snell-panel/shared";
import { installTokens, nodes, type NodeInsert, type NodeRow } from "../db/schema";
import type { AppEnv } from "../env";
import type { Db } from "../db/client";
import { requireAccess, requireAccessOrApiToken } from "../middleware/auth";
import { toNodeDTO } from "../lib/dto";
import { mintToken } from "../lib/token";
import { snellVersionFor } from "../lib/versions";
import { buildCommand } from "../lib/command";
import { lookupGeo } from "../lib/geoip";

const router = new Hono<AppEnv>();

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function getNode(db: Db, nodeId: string): Promise<NodeRow | null> {
  const rows = await db.select().from(nodes).where(eq(nodes.nodeId, nodeId)).limit(1);
  return rows[0] ?? null;
}

// GET /api/nodes — list all
router.get("/", requireAccess, async (c) => {
  const rows = await c.get("db").select().from(nodes).orderBy(desc(nodes.id));
  return c.json({ nodes: rows.map(toNodeDTO) });
});

// POST /api/nodes — create a pending (draft) node
router.post("/", requireAccess, zValidator("json", createNodeSchema), async (c) => {
  const db = c.get("db");
  const input = c.req.valid("json");

  const geo = input.ip
    ? await lookupGeo(input.ip)
    : { countryCode: null, isp: null, asn: null };

  const values: NodeInsert = {
    nodeId: crypto.randomUUID(),
    nodeName: input.node_name,
    version: input.version,
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
    version: origin.version,
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
  };
  const inserted = await db.insert(nodes).values(values).returning();
  return c.json({ node: toNodeDTO(inserted[0]) }, 201);
});

// GET /api/nodes/:id/install — mint a one-time token + build the install command
router.get("/:id/install", requireAccess, async (c) => {
  const db = c.get("db");
  const row = await getNode(db, c.req.param("id"));
  if (!row) return c.json({ error: "Node not found" }, 404);

  const version = row.version as SnellVersion;
  const { token, expiresAt } = await mintToken(db, row.nodeId, "install", now());
  const command = buildCommand({
    apiUrl: new URL(c.req.url).origin,
    node: row,
    token,
    version,
    snellVersion: snellVersionFor(c.env, version),
    purpose: "install",
  });
  return c.json({ command, token, expires_at: expiresAt, purpose: "install" });
});

// GET /api/nodes/:id/upgrade — mint a one-time token + build the V6 upgrade command
router.get("/:id/upgrade", requireAccess, async (c) => {
  const db = c.get("db");
  const row = await getNode(db, c.req.param("id"));
  if (!row) return c.json({ error: "Node not found" }, 404);

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
    const geo = await lookupGeo(input.ip);
    update.countryCode = geo.countryCode;
    update.isp = geo.isp;
    update.asn = geo.asn;
  }

  await db.update(nodes).set(update).where(eq(nodes.nodeId, id));
  const updated = await getNode(db, id);
  return c.json({ node: toNodeDTO(updated!) });
});

// DELETE /api/nodes/:id — panel (ACCESS) or installer uninstall (API_TOKEN)
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
