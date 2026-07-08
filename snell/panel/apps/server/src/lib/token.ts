import { and, eq, gte, isNull } from "drizzle-orm";
import { installTokens } from "../db/schema";
import type { Db } from "../db/client";

/** One-time install/upgrade tokens live for 5 minutes. */
export const TOKEN_TTL_SECONDS = 5 * 60;

export type TokenPurpose = "install" | "upgrade";

/** 32 random bytes, hex-encoded. */
export function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex of a token. Only the hash is stored at rest. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function mintToken(
  db: Db,
  nodeId: string,
  purpose: TokenPurpose,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const token = newToken();
  const expiresAt = now + TOKEN_TTL_SECONDS;
  await db
    .insert(installTokens)
    .values({ token: await hashToken(token), nodeId, purpose, expiresAt });
  return { token, expiresAt };
}

/**
 * Validate a token for a node WITHOUT consuming it (installer pre-flight, so a
 * doomed install never starts). Looks the token up by its hash.
 */
export async function validateToken(
  db: Db,
  token: string,
  nodeId: string,
  now: number,
): Promise<{ ok: boolean; reason?: "missing" | "used" | "expired" }> {
  const hash = await hashToken(token);
  const rows = await db
    .select()
    .from(installTokens)
    .where(and(eq(installTokens.token, hash), eq(installTokens.nodeId, nodeId)))
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: "missing" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt < now) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * Atomically consume a one-time token: a single conditional UPDATE that only
 * matches an unused, unexpired token of the right purpose for this node. If no
 * row is updated the token is rejected — this closes the check-then-update race
 * (two requests can't both see the token as "available").
 */
export async function consumeToken(
  db: Db,
  token: string,
  nodeId: string,
  purpose: TokenPurpose,
  now: number,
): Promise<boolean> {
  const hash = await hashToken(token);
  const updated = await db
    .update(installTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(installTokens.token, hash),
        eq(installTokens.nodeId, nodeId),
        eq(installTokens.purpose, purpose),
        isNull(installTokens.usedAt),
        gte(installTokens.expiresAt, now),
      ),
    )
    .returning({ token: installTokens.token });
  return updated.length > 0;
}
