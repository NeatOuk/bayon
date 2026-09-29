// DI tokens. Every constructor parameter names one with @Inject, so no provider depends on
// emitted design:paramtypes.
export const API_CONFIG = Symbol("API_CONFIG");
export const API_STORE = Symbol("API_STORE");
export const CLOCK = Symbol("CLOCK");
export const WS_TUNING_TOKEN = Symbol("WS_TUNING");
export const PAYLOAD_CONFIG = Symbol("PAYLOAD_CONFIG");
export const TICKET_SERVICE = Symbol("TICKET_SERVICE");
export const GATE_SERVICE = Symbol("GATE_SERVICE");
export const MCP_DEPS = Symbol("MCP_DEPS");
export const DIFF_SERVICE = Symbol("DIFF_SERVICE");
export const PROJECTS_SERVICE = Symbol("PROJECTS_SERVICE");
export const EXECUTORS_CREATE_SERVICE = Symbol("EXECUTORS_CREATE_SERVICE");
export const PTY_HUB = Symbol("PTY_HUB");
export const HISTORY_SERVICE = Symbol("HISTORY_SERVICE");
export const JIRA_SERVICE = Symbol("JIRA_SERVICE");
export const NOTIFICATIONS_SERVICE = Symbol("NOTIFICATIONS_SERVICE");
export const FOLDERS_SERVICE = Symbol("FOLDERS_SERVICE");
