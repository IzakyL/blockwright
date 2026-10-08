// `evidence`: observing a running game, and what a failure left behind (state, screenshots, crashes, logs).
export { observe, formatObservation, type ObserveOptions, type Observation } from "../evidence/observe.js";
export type { ClientObserveOptions, ClientObservation } from "../client/observe.js";
export {
  captureFailureEvidence as capture,
  formatFailureEvidence as format,
  markInstancesFailed as markFailed,
  evidenceShowsCrash as showsCrash,
  FAILURE_MARKER,
  type FailureEvidenceOptions as CaptureOptions,
  type FailureEvidence,
  type InstanceEvidence,
  type EvidenceScreenshot as Screenshot,
} from "../evidence/capture.js";
export {
  readCrashEvidence as readCrash,
  closeCrashEvidence as closeCrash,
  hasCrash,
  formatCrashEvidence as formatCrash,
  type CrashEvidence,
} from "../evidence/crash.js";
export {
  readGameLog as readLog,
  filterGameLog as filterLog,
  analyzeGameLog as analyzeLog,
  formatGameLogAnalysis as formatLogAnalysis,
  formatGameLogEntry as formatLogEntry,
  GAME_LOG_LEVELS as LOG_LEVELS,
  type GameLogLevel as LogLevel,
  type GameLogSource as LogSource,
  type GameLogTarget as LogTarget,
  type GameLogEntry as LogEntry,
  type GameLogFilter as LogFilter,
  type GameLogException as LogException,
  type GameLogAnalysis as LogAnalysis,
} from "../evidence/logs.js";
