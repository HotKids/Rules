import { eq } from "drizzle-orm";
import { settings } from "../db/schema";
import type { Db } from "../db/client";
import { newToken } from "./token";

const SUBSCRIBE_TOKEN_KEY = "subscribe_token";

/** Read the subscribe token, lazily creating one on first use. */
export async function getSubscribeToken(db: Db): Promise<string> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SUBSCRIBE_TOKEN_KEY))
    .limit(1);
  if (rows[0]) return rows[0].value;

  const token = newToken();
  await db
    .insert(settings)
    .values({ key: SUBSCRIBE_TOKEN_KEY, value: token })
    .onConflictDoNothing();
  const after = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SUBSCRIBE_TOKEN_KEY))
    .limit(1);
  return after[0]?.value ?? token;
}

/** Rotate the subscribe token; old subscription URLs stop working immediately. */
export async function resetSubscribeToken(db: Db): Promise<string> {
  const token = newToken();
  await db
    .insert(settings)
    .values({ key: SUBSCRIBE_TOKEN_KEY, value: token })
    .onConflictDoUpdate({ target: settings.key, set: { value: token } });
  return token;
}
