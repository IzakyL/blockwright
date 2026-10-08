// For code that builds on the prefab (UI adapters, front ends, other prefabs): template factories, sync and
// long-run plumbing, UI platform glue, formatting and log helpers. Not part of the stable surface.
export { moduleTasks, coreTask, coreClientTask, defined, waitBudget, deadlineAbove, WAIT_SLACK_MS, CORE_CLIENT_PACKAGE, type ModuleTaskOptions, type ModuleTaskFactory } from "./core/templates.js";
export { TASK_IMPORTS } from "./core/task.js";
export { JAVA_ROOT, coreModules, loadOrder } from "./core/modules.js";
export { waitSource, DEFAULT_WAIT_TIMEOUT_MS } from "./core/wait.js";
export { defaultSyncLedger, unstamp, SYNC_KEY } from "./core/sync.js";
export { LongRun, longRunId, stopLongRun, STOP_GRACE_MS, type BytesOutput } from "./core/long-run.js";
export { toMinecraftError, TIMEOUT_CODES } from "./core/errors.js";
export { formatDecimal, shortClass, reflectText, numberOr, booleanOr } from "./core/format.js";
export { faceNormal, cameraLookingAt, EYE_HEIGHT } from "./core/geometry.js";
export { REFLECT_QUERY, REFLECT_QUERY_ALL, REFLECT_INVOKE, REFLECT_SET_FIELD, REFLECT_SYMBOLS, REFLECT_RELEASE } from "./core/reflect.js";
export { worldTask } from "./world/module.js";
export { worldWaitSource, DEFAULT_WAIT_FOR_MAX_TICKS } from "./world/wait.js";
export { probeCommand } from "./world/commands.js";
export { tickBudgetMs } from "./world/tick.js";
export { stopGracefully } from "./world/lifecycle.js";
export { clientTask } from "./client/module.js";
export { observeClient, formatClientObservation } from "./client/observe.js";
export { isActionable, widgetInState } from "./client/screens.js";
export { mediaTask } from "./media/module.js";
export {
  audioBytesAt,
  ffmpegEncodeArgs,
  ffmpegMuxArgs,
  wavHeader,
  WAV_HEADER_BYTES,
  type FfmpegEncodeSpec,
  type FfmpegMuxSpec,
  type WavFormat,
} from "./media/ffmpeg.js";
export { uiReadSource, uiHover, uiWait, optionsArg, typeCode } from "./ui/platform.js";
export { GLFW_KEY_ENTER } from "./client/input.js";
export { formatServerStatus } from "./evidence/observe.js";
export { captureLaunchFailureEvidence, type LaunchFailureLike } from "./evidence/capture.js";
export { applyTraceEvent, processEndReason } from "./evidence/crash.js";
export { parseLogLines, parseLogSince, listLines } from "./evidence/logs.js";
