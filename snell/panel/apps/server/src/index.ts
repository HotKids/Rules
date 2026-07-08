import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDb } from "./db/client";
import type { AppEnv } from "./env";
import { requireAccess } from "./middleware/auth";
import { resolveVersions } from "./lib/versions";
import nodesRouter from "./routes/nodes";
import registerRouter from "./routes/register";
import subscribeRouter from "./routes/subscribe";
import settingsRouter from "./routes/settings";
import installRouter from "./routes/install";

const app = new Hono<AppEnv>();

// Attach a per-request Drizzle client.
app.use("*", async (c, next) => {
  c.set("db", createDb(c.env));
  await next();
});

// CORS for the API. Production restricts to same-origin (the SPA is served by
// this same Worker, so no cross-origin access is needed); `vite dev` runs the
// SPA on another port, so development allows any origin.
app.use("/api/*", (c, next) => {
  const mw =
    c.env.ENVIRONMENT === "development"
      ? cors()
      : cors({ origin: new URL(c.req.url).origin });
  return mw(c, next);
});

app.get("/api/snell-versions", requireAccess, (c) => c.json(resolveVersions(c.env)));

// Installer callback (token / API_TOKEN auth) must be registered before the
// admin router so its per-route auth applies, not the admin guard.
app.route("/api/nodes", registerRouter);
app.route("/api/nodes", nodesRouter);
app.route("/api/subscribe", subscribeRouter);
app.route("/api/settings", settingsRouter);
app.route("/install.sh", installRouter);

// Defensive SPA fallback. With `run_worker_first` scoped to /api/* and
// /install.sh, other paths are served by the asset layer and never reach here.
app.all("*", async (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.notFound();
});

export default app;
