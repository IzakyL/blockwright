export { UI_ROLES, UiWaitTimeoutError } from "./contract.js";
export type {
  AnyUiAdapter,
  Modifier,
  MouseButton,
  Point,
  Rect,
  UiAction,
  UiActOutcome,
  UiAdapter,
  UiCallOptions,
  UiCodegen,
  UiLayer,
  UiNode,
  UiPlatform,
  UiProbeOutcome,
  UiReadPlan,
  UiRole,
  UiSelector,
  UiWaitState,
} from "./contract.js";
export { UiHost } from "./host.js";
export type { RefEntry, UiActResult, UiHostOptions, UiTarget, UiView } from "./host.js";
export { diffViews, formatView } from "./format.js";
export { resolveRole } from "./roles.js";
export type { RoleGuess, RoleRule } from "./roles.js";
