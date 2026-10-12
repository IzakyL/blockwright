export { BlockwrightDriver } from "./driver.js";
export type { DriverMethod, DriverOptions, DriverProtocolDiagnostic } from "./driver.js";
export { BlockwrightInstance } from "./instance.js";
export type {
  EnsureModulesResult,
  InstanceStatus,
  ModuleLoadResult,
  ModuleStatus,
  ModuleUnloadResult,
  RunStatus,
  UnloadTarget,
} from "./instance.js";
export { readModuleDir } from "./modules.js";
export type { ModuleSpec, ReadModuleOptions } from "./modules.js";
export { Run } from "./run.js";
export type { Output, RunController, RunEnd, RunFailure, RunHandle, RunOptions, TaskLimits, TaskSpec, TaskThread } from "./run.js";
export type { GameChannelOptions } from "./game-channel.js";
export { launchPair } from "./launch-pair.js";
export type { InstancePair, LaunchAttemptFailure, LaunchPairOptions, PairCloseResult } from "./launch-pair.js";
export { crashAwareRetry } from "./retry.js";
export type { RetryContext, RetryPolicy } from "./retry.js";
export { closeQuietly } from "./lifecycle.js";
export { findInstance, instanceAlive, listInstances } from "./registry.js";
export type { InstanceRecord } from "./registry.js";
export {
  BlockwrightConnectionClosedError,
  BlockwrightGameRequestError,
  BlockwrightInstanceGoneError,
  BlockwrightRequestTimeoutError,
  BlockwrightRpcError,
  BlockwrightRunError,
  errorSummary,
  errorToString,
} from "./errors.js";
export type { RequestOptions, TraceEvent, WaitForReadyOptions, WaitOptions } from "./types-core.js";
export type {
  InstanceCloseOptions,
  InstanceCloseResult,
  InstanceLaunchOptions,
  InstanceLaunchResult,
  InstanceRole,
} from "./types-launch.js";
export { globMatches } from "./glob.js";
export { instanceDirOf, seedInstance } from "./seed.js";
export type { InstanceSeed, SeedCopyOptions, SeedInstanceOptions } from "./seed.js";
export { coverageReport, coverageReset } from "./coverage.js";
export type { CoverageOptions, CoverageReportOptions } from "./coverage.js";
