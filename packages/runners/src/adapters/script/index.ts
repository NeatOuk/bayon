// `@bayon/runners/script`: the generic `script` runner. Register one instance per job
// (`createScriptAdapter({ id, argv })`) wherever the supervisor builds its adapter map -- not in
// this package's registry.ts, which never names anything outside `packages/runners` (Invariant 1).
export {
  SCRIPT_CAPS,
  SCRIPT_VERSION,
  createScriptAdapter,
  type ScriptAdapterOptions,
} from "./adapter.js";
export { createScriptMapper } from "./mapper.js";
export {
  ScriptOp,
  emit,
  readGo,
  readOps,
  type ScriptGo,
  type ScriptIo,
} from "./io.js";
