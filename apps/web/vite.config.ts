import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultClientConditions, defineConfig } from "vite";
import { PREVIEW_PORT, devSetup, refuseTakenPort } from "./dev-config.js";
import { apiProxy } from "./dev-proxy.js";
import { LOCAL_KEY_FILE, localKeyReader } from "./server/local-browser.js";

// The ports, the API and the bearer come from this home (dev-config.ts): FRM_HOME's install.json,
// or FRM_WEB_PORT / FRM_API_HOST / FRM_API_PORT / FRM_API_TOKEN; with none of them, 5173 and
// 127.0.0.1:3010 as always. FRM_WEB_HOST: the address the GUI listens on (default localhost;
// 0.0.0.0 for the LAN). The API stays on its own host. A LAN address must also be listed in
// FRM_WEB_ORIGINS to get the bearer.
const WEB_HOST = process.env.FRM_WEB_HOST;

/** Set once this process checked its port: a config reload must not find its own server there. */
const CHECKED = Symbol.for("bayon.web.port-checked");
const marks = globalThis as { [CHECKED]?: boolean };

export default defineConfig(async ({ command, isPreview }) => {
  const serving = command === "serve";
  const setup = await devSetup(process.env, { readToken: serving });
  if (!setup.ok) throw new Error(`GUI: ${setup.error.message}`);
  const { apiTarget, devPort, token, allowedOrigins, home } = setup.value;
  if (serving && marks[CHECKED] !== true) {
    await refuseTakenPort(isPreview === true ? PREVIEW_PORT : devPort);
    marks[CHECKED] = true;
    if (token === undefined)
      console.warn(
        "GUI: no API token: set FRM_HOME to an install that ran pnpm frm init, or FRM_API_TOKEN; the API refuses every request until then",
      );
  }
  const proxy = apiProxy({
    target: apiTarget,
    token,
    allowedOrigins,
    // The host-only key the API wrote to this install's home, the same home the ports came from
    // (§14 amendment). Unreadable: no browser counts as local.
    localKey: localKeyReader(join(home, LOCAL_KEY_FILE)),
  });
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
      // Workspace packages from their sources, as in tests: never a stale dist/.
      conditions: ["@bayon/source", ...defaultClientConditions],
    },
    server: { host: WEB_HOST, port: devPort, strictPort: true, proxy },
    preview: { host: WEB_HOST, port: PREVIEW_PORT, strictPort: true, proxy },
    // tsc -b owns dist/ (declarations, build info); the app goes beside it.
    build: { outDir: "dist/app", emptyOutDir: true },
  };
});
