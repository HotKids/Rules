import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Token from `Authorization: Bearer <t>` only — never the URL. */
export function bearerToken(c: Context<AppEnv>): string | null {
  const auth = c.req.header("Authorization");
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Token from `Authorization: Bearer <t>` or the `?token=` query param.
 *  Used only where a URL token is required: subscriptions and installer callbacks. */
export function extractToken(c: Context<AppEnv>): string | null {
  return bearerToken(c) ?? c.req.query("token") ?? null;
}

/** Control-plane guard: requires the panel ACCESS_TOKEN via Authorization only.
 *  Keeping the access token out of URLs avoids it leaking into logs/referrers. */
export const requireAccess = createMiddleware<AppEnv>(async (c, next) => {
  const tok = bearerToken(c);
  if (!tok || !safeEqual(tok, c.env.ACCESS_TOKEN)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

/** True when the request carries the master API_TOKEN (bearer or query). */
export function hasApiToken(c: Context<AppEnv>): boolean {
  const tok = extractToken(c);
  return tok !== null && safeEqual(tok, c.env.API_TOKEN);
}

/** Data-plane guard: panel ACCESS_TOKEN (Authorization only) or the API_TOKEN
 *  (bearer or query, so the uninstall script's `?token=` still works). */
export const requireAccessOrApiToken = createMiddleware<AppEnv>(async (c, next) => {
  const bearer = bearerToken(c);
  if (bearer && safeEqual(bearer, c.env.ACCESS_TOKEN)) {
    await next();
    return;
  }
  if (hasApiToken(c)) {
    await next();
    return;
  }
  return c.json({ error: "Unauthorized" }, 401);
});
