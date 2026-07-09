import type { Db } from "./db/client";

/** Bindings configured in wrangler.jsonc (D1, assets, secrets, vars). */
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Frontend / panel auth (control plane). Typed into the panel. */
  ACCESS_TOKEN: string;
  /** Backend master write secret (data plane). Never leaves the backend. */
  API_TOKEN: string;
  /** Exact "latest" build per family; defaults applied in lib/versions.ts. */
  SNELL_V5_VERSION?: string;
  SNELL_V6_VERSION?: string;
  /** "development" relaxes CORS for `vite dev`; anything else = production. */
  ENVIRONMENT?: string;
}

export interface Variables {
  db: Db;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
