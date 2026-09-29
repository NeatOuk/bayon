import { systemClock } from "@bayon/core";
import { bootApi } from "./boot.js";

// The API process: `pnpm --filter @bayon/api start`, with FRM_API_TOKEN and FRM_DB or FRM_HOME set
// (FRM_API_HOST and FRM_API_PORT optional). It exits non-zero rather than serve a DB it cannot trust.

const booted = await bootApi({ env: process.env, clock: systemClock });
if (!booted.ok) {
  console.error(
    `api refused to start: ${booted.error.class}: ${booted.error.message}`,
  );
  process.exit(1);
}

const { api, close } = booted.value;
console.log(`api listening on ${api.url} (ws ${api.wsUrl})`);

const shutdown = (): void => {
  close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error("api shutdown failed", error);
      process.exit(1);
    },
  );
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
