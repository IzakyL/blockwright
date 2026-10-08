// `tick`: the server's tick rate manager — freeze, rate, sprint, step.
export {
  tickStatus as status,
  tickFreeze as freeze,
  tickRate as rate,
  tickSprint as sprint,
  tickStep as step,
  type TickAdvanceOptions as AdvanceOptions,
} from "../world/tick.js";
export type { TickStatus as Status, TickAdvance as Advance } from "../world/types.js";
