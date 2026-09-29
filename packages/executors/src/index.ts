export type {
  Argv,
  Capacity,
  CleanupMode,
  ExecOpts,
  Executor,
  ExecutorCapabilities,
  ExecutorHealthReport,
  ExecutorKind,
  ExecutorMirrors,
  ExitStatus,
  MirrorPin,
  KillSignal,
  Owned,
  PipeRelease,
  Prepared,
  PrepareSpec,
  ProbeState,
  Proc,
  ProcStdin,
  PtyOpts,
  PtyProc,
  ReleaseOptions,
  SessionPlace,
} from "./types.js";
export { SlotCounter, tryAcquireAll, type Slot } from "./slots.js";
// Git run by the supervisor (SAFE_GIT, and git as its own process group;
// SESSION_GIT_ENV, the same floor for the git an agent session runs.
export {
  GIT_ENV_FLOOR,
  GIT_ENV_FLOOR_SH,
  REMOTE_GIT_ENV,
  REMOTE_PROTOCOLS,
  remoteProtocolFlags,
  GIT_STDOUT_CAP,
  GIT_TOKEN_ENV,
  GIT_TOKEN_HOST_ENV,
  gitTokenEnv,
  gitSubcommand,
  gitTokenFlags,
  runGitGroup,
  SAFE_GIT,
  SAFE_GIT_SH,
  safeGitArgs,
  SESSION_GIT_ENV,
  type GitGroupOptions,
  type GitRan,
} from "./git.js";
// The host secret store (§14): the supervisor's spawn secrets and the backup key.
export {
  envSecrets,
  fileSecrets,
  firstOf,
  getSourced,
  hostSecrets,
  isSecretMissing,
  keychainSecrets,
  putKeychainSecret,
  type HostSecrets,
  type HostSecretStores,
  type KeychainOptions,
  type KeychainPut,
  type SecretSource,
  type SecretStore,
  type SourcedSecret,
} from "./secrets.js";
// Which install's Keychain service a process reads.
export {
  GUARDED_HOME,
  NO_DEFAULT_HOME_ENV,
  OWNER_KEYCHAIN_SERVICE,
  defaultHome,
  installHome,
  keychainScope,
  type KeychainScope,
} from "./keychain-scope.js";
// Where an install listens, its bearer, and where its sockets go (..257).
export {
  API_TOKEN_NAME,
  DEFAULT_API_HOST,
  DEFAULT_PORTS,
  INSTALL_FILE,
  InstallFile,
  LONGEST_SOCKET_NAME_BYTES,
  SOCKET_PATH_MAX_BYTES,
  apiUrl,
  darwinUserTempDir,
  ensureSocketDir,
  installPorts,
  mcpUrl,
  portFree,
  readApiToken,
  readInstallFile,
  socketDir,
  socketsFit,
  verifySocketDir,
  verifySocketFile,
  writeInstallFile,
  type ApiTokenOptions,
  type InstallPorts,
  type SocketDirOptions,
} from "./install-entry.js";
// A login the operator's own CLI owns and rotates, read and returned in place with consent (§14).
export {
  MAX_LOGIN_BYTES,
  readLiveLogin,
  writeLiveLogin,
  type LiveLogin,
} from "./live-login.js";
export { LocalExecutor, type LocalExecutorOptions } from "./local/local.js";
export { readProc, type ProcInfo } from "./local/proc-info.js";
// Who holds a home's supervisor lock, judged without touching it.
export { LockOwner, lockHolder, type LockHolder } from "./lock-holder.js";
// The two tags a session's environment carries, by which listOwned finds it.
export { HOME_TAG_ENV, SESSION_ID_ENV } from "./local/proc-scan.js";
export {
  ContainerExecutor,
  type ContainerExecutorOptions,
  type ExecutorUsage,
} from "./container/container.js";
export {
  ContainerExecutorConfig,
  EGRESS_HOST,
  type ContainerExecutorConfigInput,
} from "./container/config.js";
export type { BuiltImage } from "./container/image.js";
export { EXECUTOR_ID, pinKnownHosts } from "./container/host-key.js";
export { MAX_PIN_REFS, PIN_REF } from "./container/scripts.js";
/** Mirrors named with it are the executor's own, never a repo's (H1). */
export { RESERVED_MIRROR_PREFIX } from "@bayon/core";
export type { ExecutorDiagnostic } from "./container/proc.js";
