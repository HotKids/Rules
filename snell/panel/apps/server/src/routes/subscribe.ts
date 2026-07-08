import { Hono } from "hono";
import { like } from "drizzle-orm";
import {
  SUBSCRIPTION_FORMATS,
  type SubscriptionFormat,
} from "@snell-panel/shared";
import { nodes } from "../db/schema";
import type { AppEnv } from "../env";
import { extractToken, safeEqual } from "../middleware/auth";
import { getSubscribeToken } from "../lib/settings";
import { renderSubscription } from "../lib/subscription";

const router = new Hono<AppEnv>();

// GET /api/subscribe?token=<SUBSCRIBE_TOKEN>&format=&filter=&flag=&via=
router.get("/", async (c) => {
  const tok = extractToken(c);
  const subToken = await getSubscribeToken(c.get("db"));
  if (!tok || !safeEqual(tok, subToken)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const format = parseFormat(c.req.query("format"), c.req.query());
  const via = c.req.query("via") || undefined;
  const filter = c.req.query("filter") || "";
  const showFlag = c.req.query("flag") !== "false";

  const db = c.get("db");
  const rows = filter
    ? await db.select().from(nodes).where(like(nodes.nodeName, `%${filter}%`)).orderBy(nodes.id)
    : await db.select().from(nodes).orderBy(nodes.id);

  return c.text(renderSubscription(rows, { format, via, showFlag }));
});

function parseFormat(
  explicit: string | undefined,
  query: Record<string, string>,
): SubscriptionFormat {
  const lower = explicit?.toLowerCase();
  if (lower && (SUBSCRIPTION_FORMATS as readonly string[]).includes(lower)) {
    return lower as SubscriptionFormat;
  }
  if (isTruthy(query.shadowrocket)) return "shadowrocket";
  if (isTruthy(query.mihomo)) return "mihomo";
  return "surge";
}

function isTruthy(v: string | undefined): boolean {
  return v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export default router;
