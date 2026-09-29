import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defaultClientConditions, defineConfig } from "vite";
import { apiProxy, extraOrigins } from "./dev-proxy.js";

const DEV_PORT = 5173;
const PREVIEW_PORT = 4173;
// The API's own FRM_API_HOST / FRM_API_PORT, with its defaults (apps/api/src/config.ts).
const API_TARGET = `http://${process.env.FRM_API_HOST ?? "127.0.0.1"}:${process.env.FRM_API_PORT ?? "3010"}`;
// FRM_WEB_HOST: the address the GUI listens on (default localhost; 0.0.0.0 for the LAN). The API
// stays on its own host. A LAN address must also be listed in FRM_WEB_ORIGINS to get the bearer.
const WEB_HOST = process.env.FRM_WEB_HOST;

const proxy = apiProxy({
  target: API_TARGET,
  token: process.env.FRM_API_TOKEN,
  allowedOrigins: new Set([
    ...[DEV_PORT, PREVIEW_PORT].flatMap((port) => [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ]),
    ...extraOrigins(process.env.FRM_WEB_ORIGINS),
  ]),
});

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // Workspace packages from their sources, as in tests: never a stale dist/.
    conditions: ["@bayon/source", ...defaultClientConditions],
  },
  server: { host: WEB_HOST, port: DEV_PORT, strictPort: true, proxy },
  preview: { host: WEB_HOST, port: PREVIEW_PORT, strictPort: true, proxy },
  // tsc -b owns dist/ (declarations, build info); the app goes beside it.
  build: { outDir: "dist/app", emptyOutDir: true },
});
