import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During `vite dev`, proxy the API + provisioner to the local Worker (`wrangler dev`).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/install.sh": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // esbuild 0.28 can't down-level some syntax (e.g. destructuring) to the
    // default es2020-ish target; modern browsers support es2022 natively.
    target: "es2022",
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing vendor code from app code so app
        // edits don't invalidate the whole ~650 kB bundle in browser caches.
        // Path-based routing also catches transitive deps (e.g. framer-motion).
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (/node_modules\/(@heroui|framer-motion|motion-dom|motion-utils|@react-aria|@react-stately|@react-types)\//.test(id)) return "heroui";
          return "vendor";
        },
      },
    },
  },
});
