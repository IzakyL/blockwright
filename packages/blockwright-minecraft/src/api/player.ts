// `player`: the local player — its state, where it is and looks, and what it does in the world.
export { statePlayer as state, stateNearby as nearby, playerPlace as place, type PlayerPlacement as Placement, type PlayerPlaceResult as PlaceResult } from "../client/state.js";
export {
  aimAt as aim,
  useBlock,
  useItem,
  useEntity,
  clickTarget as click,
  clickWorld as clickBlock,
  type AimOptions,
  type AimResult,
  type UseBlockOptions,
  type UseBlockResult,
  type UseItemResult,
  type UseEntityResult,
  type EntityRef,
  type InteractionResultJson as InteractionResult,
  type ClickTargetResult as ClickResult,
  type ClickWorldOptions as ClickBlockOptions,
  type ClickWorldResult as ClickBlockResult,
} from "../client/interact.js";
export type {
  ClientPlayerJson as State,
  NearbyEntity,
  NearbyEntities,
  InteractionHandName as Hand,
  ServerRoundTrip,
  HitResultJson as HitResult,
} from "../client/types.js";
