// `@bayon/executors/install`: an install's ports and URLs, its API bearer and its socket directory,
// without the executors themselves (no node-pty), so the GUI's Vite config can import it.
export {
  DEFAULT_API_HOST,
  DEFAULT_PORTS,
  INSTALL_FILE,
  InstallFile,
  apiUrl,
  installPorts,
  mcpUrl,
  readInstallFile,
  writeInstallFile,
  type InstallPorts,
} from "./install.js";
export {
  API_TOKEN_NAME,
  readApiToken,
  type ApiTokenOptions,
} from "./api-token.js";
export {
  LONGEST_SOCKET_NAME_BYTES,
  SOCKET_PATH_MAX_BYTES,
  darwinUserTempDir,
  ensureSocketDir,
  socketDir,
  socketsFit,
  verifySocketDir,
  verifySocketFile,
  type SocketDirOptions,
} from "./socket-dir.js";
export { portFree } from "./port-probe.js";
export { installHome } from "./keychain-scope.js";
