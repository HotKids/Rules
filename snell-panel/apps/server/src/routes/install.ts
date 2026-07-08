import { Hono } from "hono";
import type { AppEnv } from "../env";
// Bundled as a text module via wrangler `rules` (type: "Text", globs: ["**/*.sh"]).
import installScript from "../../../../scripts/panel-install.sh";

// Normalize line endings to LF. If the repo was checked out on Windows (git
// autocrlf), the bundled script could contain CRLF, which breaks `bash` with
// "$'\r': command not found". Strip CR so the served script is always LF.
const script = installScript.replace(/\r\n?/g, "\n");

const router = new Hono<AppEnv>();

// GET /install.sh — serve the provisioner so the generated command can curl it.
router.get("/", (c) => {
  c.header("Content-Type", "text/x-shellscript; charset=utf-8");
  c.header("Cache-Control", "no-cache");
  return c.body(script);
});

export default router;
