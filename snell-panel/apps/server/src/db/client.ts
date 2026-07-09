import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import type { Bindings } from "../env";

export function createDb(env: Bindings) {
  return drizzle(env.DB, { schema });
}

export type Db = ReturnType<typeof createDb>;
