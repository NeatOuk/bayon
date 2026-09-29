// The production web server's process: `node dist/server/main.js`, with
// FRM_SECRET_STORE=file, FRM_SECRETS_DIR, FRM_WEB_ORIGINS and FRM_API_TARGET. It exits non-zero
// rather than serve without its secrets. Logs are JSON lines; they never carry a secret or a cookie.
import { fileURLToPath } from "node:url";
import { systemClock } from "@bayon/core";
import { loadEdgeConfig } from "./config.js";
import { createEdge, type EdgeLog } from "./edge.js";

const log: EdgeLog = (level, msg, fields = {}) => {
  const line = JSON.stringify({ time: Date.now(), level, msg, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
};

// dist/server/main.js → dist/app, where `vite build` writes the app.
const loaded = loadEdgeConfig(
  process.env,
  fileURLToPath(new URL("../app", import.meta.url)),
);
if (!loaded.ok) {
  log("error", `web refused to start: ${loaded.error.message}`);
  process.exit(1);
}

const { listen, config } = loaded.value;
const edge = createEdge({ config, clock: systemClock, log });
edge.server.listen(listen.port, listen.host, () =>
  log("info", "web listening", {
    host: listen.host,
    port: listen.port,
    origins: [...config.origins],
  }),
);

const shutdown = (): void => {
  edge.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
