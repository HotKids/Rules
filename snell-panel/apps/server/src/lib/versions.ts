import type { SnellVersion, SnellVersionsResponse } from "@snell-panel/shared";
import type { Bindings } from "../env";

// Defaults match the constants in OpenSnell's installer. Override per-deployment
// with the SNELL_V5_VERSION / SNELL_V6_VERSION Worker vars.
const DEFAULT_V5 = "v5.0.1";
const DEFAULT_V6 = "v6.0.0b4";

export function resolveVersions(env: Bindings): SnellVersionsResponse {
  return {
    v5: env.SNELL_V5_VERSION?.trim() || DEFAULT_V5,
    v6: env.SNELL_V6_VERSION?.trim() || DEFAULT_V6,
  };
}

/** Resolve a version family ('5' | '6') to its exact "latest" build string. */
export function snellVersionFor(env: Bindings, family: SnellVersion): string {
  const v = resolveVersions(env);
  return family === "6" ? v.v6 : v.v5;
}
