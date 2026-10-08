// `screen`: the open screen (GUI), its widgets and container slots, and the HUD.
export {
  stateScreen as current,
  screenWidgets as widgets,
  containerSlots as slots,
  waitForScreen as waitFor,
  waitForWidget,
  clickWidget,
  clickSlot,
  dismissScreen as dismiss,
  selectWidget,
  type ScreenWaitOptions as WaitOptions,
  type WidgetWaitOptions,
  type ClickWidgetOptions,
  type ClickWidgetResult,
  type ClickSlotResult,
  type ScreenClickOptions as ClickOptions,
} from "../client/screens.js";
export { stateHudText as hud } from "../client/state.js";
export type {
  ScreenInfo as Info,
  ScreenWidget as Widget,
  ScreenSlot as Slot,
  WidgetSelector,
  WidgetState,
  DismissResult,
  HudText,
  HudTextEntry,
} from "../client/types.js";
