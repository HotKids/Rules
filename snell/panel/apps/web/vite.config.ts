import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// During `vite dev`, proxy the API + installer to the local Worker (`wrangler dev`).
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
  },
});
