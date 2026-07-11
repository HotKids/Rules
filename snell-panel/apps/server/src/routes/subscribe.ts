import { Hono } from "hono";
import { and, eq, like } from "drizzle-orm";
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
  // Strip CR/LF so a crafted `via` can't inject extra lines/directives into the
  // rendered config (it's reflected verbatim into Surge/Mihomo node entries).
  const via = (c.req.query("via") || "").replace(/[\r\n]+/g, " ").trim() || undefined;
  const filter = c.req.query("filter") || "";
  const showFlag = c.req.query("flag") !== "false";

  // A subscription only ever serves enabled+active nodes; there is deliberately
  // no `enabled` query override (it would only contradict the base predicate).
  const predicates = [eq(nodes.status, "active"), eq(nodes.enabled, true)];
  const structured = ["tag", "region", "vendor", "protocol"] as const;
  for (const key of structured) {
    const value = c.req.query(key);
    if (!value) continue;
    if (key === "tag") predicates.push(like(nodes.tags, `%"${value}"%`));
    if (key === "region") predicates.push(eq(nodes.region, value));
    if (key === "vendor") predicates.push(eq(nodes.vendor, value));
    if (key === "protocol") predicates.push(eq(nodes.protocol, value));
  }
  if (filter) predicates.push(like(nodes.nodeName, `%${filter}%`));

  const db = c.get("db");
  const rows = await db.select().from(nodes).where(and(...predicates)).orderBy(nodes.id);

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
