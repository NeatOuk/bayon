import { systemClock } from "@bayon/core";
import { z } from "zod";
import { bootApi } from "./boot.js";
import { apiLogger } from "./quiet-logger.js";

// The API process: `pnpm --filter @bayon/api start`, with FRM_DB or FRM_HOME set; the token from
// FRM_API_TOKEN or this home's store (`pnpm frm init`), the port from FRM_API_PORT or the home's
// install.json. It exits non-zero rather than serve a DB it cannot trust.

const PendingMigrations = z.object({ pending: z.array(z.string()) });

const logger = apiLogger(process.env);
const booted = await bootApi({
  env: process.env,
  clock: systemClock,
  ...(logger === undefined ? {} : { logger }),
});
if (!booted.ok) {
  console.error(`The API did not start: ${booted.error.message}`);
  // The one cause printed: the migrations still to apply, which the headline only counts. Other
  // causes stay out of the terminal, since a config error's may carry a secret store's detail.
  const pending = PendingMigrations.safeParse(booted.error.cause);
  if (pending.success)
    console.error(`Migrations to apply: ${pending.data.pending.join(", ")}`);
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
