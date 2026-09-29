// conformance_echo (§15 test 11): answers its nonce and leaves an audit row naming it,
// which is how the supervisor's probe sees the call arrive with the right bearer. Only a
// conformance probe's token is served this tool (db-store.ts).
import { CONFORMANCE_NONCE_TARGET, MCP_INPUTS } from "@bayon/proto";
import { done, failed, type Handler } from "./tool-kit.js";

const conformanceEcho: Handler = async (ctx, raw) => {
  const input = MCP_INPUTS.conformance_echo.parse(raw);
  const logged = await ctx.store.audit(
    ctx.audit(CONFORMANCE_NONCE_TARGET, input.nonce),
  );
  return logged.ok ? done({ nonce: input.nonce }) : failed(logged.error);
};

export const CONFORMANCE_HANDLERS: Readonly<Record<string, Handler>> = {
  conformance_echo: conformanceEcho,
};
