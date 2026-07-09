import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { heartbeatSchema, installFailedSchema, registerNodeSchema, type NodeProtocol } from "@snell-panel/shared";
import { nodes, type NodeInsert, type NodeRow } from "../db/schema";
import type { AppEnv } from "../env";
import type { Db } from "../db/client";
import { extractToken, hasApiToken } from "../middleware/auth";
import { consumeToken, expectedPurpose, validateToken, type TokenPurpose } from "../lib/token";
import { getNode, nowSeconds } from "../lib/node-repo";
import { lookupGeo } from "../lib/geoip";
import { toNodeDTO } from "../lib/dto";

const router = new Hono<AppEnv>();

/**
 * Authorize a provisioner callback for a node: the master API_TOKEN always
 * passes; otherwise the request must carry a one-time node token matching the
 * node's current lifecycle `purpose`. `consume: true` atomically burns it
 * (register), otherwise it's only validated (pre-flight / failure / heartbeat
 * callbacks that may fire more than once).
 */
async function authorizeNode(
  c: Context<AppEnv>,
  db: Db,
  nodeId: string,
  purpose: TokenPurpose,
  ts: number,
  opts: { consume?: boolean } = {},
): Promise<boolean> {
  if (hasApiToken(c)) return true;
  const token = extractToken(c);
  if (!token) return false;
  return opts.consume
    ? consumeToken(db, token, nodeId, purpose, ts)
    : (await validateToken(db, token, nodeId, ts, [purpose])).ok;
}

/**
 * The ip/port fields a self-reported callback (heartbeat) is allowed to write.
 * Admin-prefilled ip/port stay authoritative; an undefined report leaves the
 * stored value untouched. Returns only the keys that should change.
 */
function reportedIpPort(row: NodeRow, ip?: string | null, port?: number): Partial<NodeInsert> {
  const patch: Partial<NodeInsert> = {};
  if (!row.ipPrefilled && ip !== undefined) patch.ip = ip;
  if (!row.portPrefilled && port !== undefined) patch.port = port;
  return patch;
}

// GET /api/nodes/:id/verify-token — provisioner pre-flight; does NOT consume the token.
router.get("/:id/verify-token", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (hasApiToken(c)) return c.json({ ok: true });

  const token = extractToken(c);
  if (!token) return c.json({ ok: false, error: "missing token" }, 401);

  const row = await getNode(db, id);
  if (!row) return c.json({ ok: false, error: "missing" }, 401);

  const ts = nowSeconds();
  const res = await validateToken(db, token, id, ts, [expectedPurpose(row.status)]);
  if (!res.ok) return c.json({ ok: false, error: res.reason }, 401);
  await db.update(nodes).set({ status: "installing", installStartedAt: ts, lastError: null }).where(eq(nodes.nodeId, id));
  return c.json({ ok: true });
});

// POST /api/nodes/:id/register — provisioner callback (one-time token OR API_TOKEN)
router.post("/:id/register", zValidator("json", registerNodeSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const input = c.req.valid("json");

  const row = await getNode(db, id);
  if (!row) return c.json({ error: "Node not found" }, 404);
  const rowProtocol = (row.protocol ?? "snell") as NodeProtocol;
  const inputProtocol = input.protocol ?? (input.version === "2022" ? "ss2022" : "snell");
  if (inputProtocol !== rowProtocol) {
    return c.json({ error: "Protocol mismatch" }, 400);
  }

  // The token's purpose must match the node's lifecycle: a pending node expects
  // an 'install' token, an active/upgrading node an 'upgrade' token.
  const ts = nowSeconds();
  if (!(await authorizeNode(c, db, id, expectedPurpose(row.status), ts, { consume: true }))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // Pre-filled IP/Port stay authoritative; otherwise take the reported values.
  const ip = row.ipPrefilled && row.ip ? row.ip : input.ip ?? row.ip ?? null;
  const port = row.portPrefilled && row.port ? row.port : input.port;

  const geo = ip
    ? await lookupGeo(ip)
    : { countryCode: null, isp: null, asn: null };

  await db
    .update(nodes)
    .set({
      ip,
      port,
      psk: input.psk,
      protocol: rowProtocol,
      version: input.version,
      method: rowProtocol === "ss2022" ? input.method ?? row.method : null,
      status: "active",
      installFinishedAt: ts,
      lastSeenAt: ts,
      lastError: null,
      countryCode: geo.countryCode,
      isp: geo.isp,
      asn: geo.asn,
      registeredAt: ts,
    })
    .where(eq(nodes.nodeId, id));

  const updated = await getNode(db, id);
  return c.json({ node: toNodeDTO(updated!) });
});

// POST /api/nodes/:id/install-failed — provisioner failure callback.
router.post("/:id/install-failed", zValidator("json", installFailedSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const ts = nowSeconds();
  const row = await getNode(db, id);
  if (!row) return c.json({ error: "Node not found" }, 404);
  if (!(await authorizeNode(c, db, id, expectedPurpose(row.status), ts))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const input = c.req.valid("json");
  await db.update(nodes).set({ status: "failed", installFinishedAt: ts, lastError: input.error }).where(eq(nodes.nodeId, id));
  return c.json({ ok: true });
});

// POST /api/nodes/:id/heartbeat — node-scoped health callback.
router.post("/:id/heartbeat", zValidator("json", heartbeatSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const ts = nowSeconds();
  const row = await getNode(db, id);
  if (!row) return c.json({ error: "Node not found" }, 404);
  if (!(await authorizeNode(c, db, id, expectedPurpose(row.status), ts))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const input = c.req.valid("json");
  await db.update(nodes).set({
    status: input.service_active ? "active" : "failed",
    lastSeenAt: ts,
    lastCheckAt: ts,
    lastError: input.error ?? null,
    ...reportedIpPort(row, input.ip, input.port),
  }).where(eq(nodes.nodeId, id));
  return c.json({ ok: true });
});

export default router;
