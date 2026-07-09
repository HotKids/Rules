import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAccess } from "../middleware/auth";
import { getSubscribeToken, resetSubscribeToken } from "../lib/settings";

const router = new Hono<AppEnv>();

// GET /api/settings — current subscribe token
router.get("/", requireAccess, async (c) => {
  const subscribe_token = await getSubscribeToken(c.get("db"));
  return c.json({ subscribe_token });
});

// POST /api/settings/subscribe-token/reset — rotate the subscribe token
router.post("/subscribe-token/reset", requireAccess, async (c) => {
  const subscribe_token = await resetSubscribeToken(c.get("db"));
  return c.json({ subscribe_token });
});

export default router;
