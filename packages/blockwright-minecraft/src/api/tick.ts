// `tick`: the server's tick rate manager — freeze, rate, sprint, step.
export {
  tickStatus as status,
  tickFreeze as freeze,
  tickRate as rate,
  tickSprint as sprint,
  tickStep as step,
  tickSample as sample,
  type TickAdvanceOptions as AdvanceOptions,
  type TickSampleOptions as SampleOptions,
  type TickSamples as Samples,
} from "../world/tick.js";
export type { TickStatus as Status, TickAdvance as Advance } from "../world/types.js";

import { tickMeterDump, tickMeterStart, tickMeterSummary } from "../world/tick.js";

/** Every tick's duration, kept in the game: `start` it, run the world, then `dump` the rows or read the `summary`. */
export const meter = { start: tickMeterStart, dump: tickMeterDump, summary: tickMeterSummary } as const;
export { TICK_METER_COLUMNS as METER_COLUMNS, type TickMeterStart as MeterStart, type TickMeterDump as MeterDump, type TickMeterSummary as MeterSummary } from "../world/tick.js";
