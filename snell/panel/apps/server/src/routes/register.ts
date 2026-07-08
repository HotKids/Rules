import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { registerNodeSchema } from "@snell-panel/shared";
import { nodes } from "../db/schema";
import type { AppEnv } from "../env";
import { extractToken, hasApiToken } from "../middleware/auth";
import { consumeToken, validateToken } from "../lib/token";
import { lookupGeo } from "../lib/geoip";
import { toNodeDTO } from "../lib/dto";

const router = new Hono<AppEnv>();

// GET /api/nodes/:id/verify-token — installer pre-flight; does NOT consume the token.
router.get("/:id/verify-token", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  if (hasApiToken(c)) return c.json({ ok: true });

  const token = extractToken(c);
  if (!token) return c.json({ ok: false, error: "missing token" }, 401);

  const res = await validateToken(db, token, id, Math.floor(Date.now() / 1000));
  if (!res.ok) return c.json({ ok: false, error: res.reason }, 401);
  return c.json({ ok: true });
});

// POST /api/nodes/:id/register — installer callback (one-time token OR API_TOKEN)
router.post("/:id/register", zValidator("json", registerNodeSchema), async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const input = c.req.valid("json");

  const rows = await db.select().from(nodes).where(eq(nodes.nodeId, id)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "Node not found" }, 404);

  // Authorize via the master API token, else consume a valid one-time token.
  // The token's purpose must match the node's lifecycle: a pending node expects
  // an 'install' token, an active node an 'upgrade' token.
  const ts = Math.floor(Date.now() / 1000);
  const expectedPurpose = row.status === "active" ? "upgrade" : "install";
  let authorized = hasApiToken(c);
  if (!authorized) {
    const token = extractToken(c);
    authorized =
      token !== null && (await consumeToken(db, token, id, expectedPurpose, ts));
  }
  if (!authorized) return c.json({ error: "Unauthorized" }, 401);

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
      version: input.version,
      status: "active",
      countryCode: geo.countryCode,
      isp: geo.isp,
      asn: geo.asn,
      registeredAt: ts,
    })
    .where(eq(nodes.nodeId, id));

  const updated = (
    await db.select().from(nodes).where(eq(nodes.nodeId, id)).limit(1)
  )[0];
  return c.json({ node: toNodeDTO(updated) });
});

export default router;
