/**
 * The adapter-neutral UI contract. Nothing here knows a game or a UI library: an adapter (the vanilla
 * screens of @izakyl/blockwright-minecraft, a UI library's panels, ...) reads a screen into {@link UiNode}s, names nodes
 * with its own {@link UiSelector}s and acts on them; a {@link UiPlatform} (the game prefab) runs the
 * in-game work the host needs of every adapter at once. Dependencies point inward: this package depends on
 * nothing game-specific, and platforms and adapters implement it.
 *
 * Two type parameters thread through everything, both opaque here:
 * - `Client`: the handle in-game work runs through (a `MinecraftClient`, say);
 * - `Probe`: one piece of in-game reading, in whatever form the platform runs (Java, a reflect query).
 */

/** GUI-scaled coordinates, the space pointer input takes. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export type UiRole =
  | "panel" | "button" | "slot" | "text" | "textbox" | "checkbox" | "slider"
  | "list" | "scroll" | "tab" | "image" | "unknown";

export const UI_ROLES: readonly UiRole[] = [
  "panel", "button", "slot", "text", "textbox", "checkbox", "slider", "list", "scroll", "tab", "image", "unknown",
];

export interface UiNode {
  /** Identity within the adapter that survives a re-read wherever the library allows it; the host
   *  diffs trees and hands out refs by it. */
  key: string;
  role: UiRole;
  /** What a person would call it: label, text, tooltip, or the item in a slot. */
  name?: string;
  value?: string;
  className: string;
  /** Layout box, unclipped. */
  bounds: Rect;
  /** The part actually drawn once clipping ancestors are applied; absent when nothing is drawn. */
  visibleBounds?: Rect;
  states: {
    enabled: boolean;
    visible: boolean;
    /** A click at the centre of visibleBounds reaches this node. */
    hittable: boolean;
    /** Set by the host: what in a lower layer takes a click aimed at this node instead. */
    blockedBy?: string;
  };
  item?: { id: string; count?: number };
  /** A game-side handle to the object, when the adapter keeps one. */
  handle?: string;
  children: UiNode[];
}

/** One adapter's reading of the open screen. */
export interface UiLayer<State = unknown> {
  adapter: string;
  roots: UiNode[];
  /** Nodes of layers beneath this one that this layer draws itself; the host drops them so each
   *  thing on screen is listed once. */
  supersedes?: (adapter: string, node: UiNode) => boolean;
  /** Whatever the adapter needs to locate nodes of this read later (plain data or not; never sent anywhere). */
  state: State;
}

/** What one probe answered: its value, or why it could not be read (other probes are unaffected). */
export type UiProbeOutcome =
  | { ok: unknown; error?: undefined }
  | { ok?: undefined; error: { code: string; message: string } };

/**
 * An adapter's read, split into probes and a pure parser so the host can run every adapter's probes in
 * one in-game task (one client-thread turn, one frame) — alone, or folded into a larger task.
 */
export interface UiReadPlan<Probe, State> {
  /** Names only need to be unique within the adapter; the host namespaces them. */
  probes: Record<string, Probe>;
  /**
   * `undefined` means the open screen is not this library's (or there is none). Throw only when it is,
   * but cannot be read; the host reports that as an error of this adapter and keeps the other layers.
   */
  parse(outcomes: Readonly<Record<string, UiProbeOutcome>>): UiLayer<State> | undefined;
}

/** Adapter-owned locator. Plain JSON: the host keeps it behind a ref and codegen writes it into specs. */
export type UiSelector = Record<string, string | number | boolean | readonly number[] | undefined>;

export type Modifier = "shift" | "ctrl" | "alt";
export type MouseButton = "left" | "right" | "middle";

export type UiAction =
  /** `double` clicks twice in quick succession; single clicks are kept far enough apart not to read as one. */
  | { kind: "click"; button?: MouseButton; modifiers?: readonly Modifier[]; double?: boolean }
  | { kind: "hover" }
  | { kind: "scrollIntoView" }
  /** Wheel lines at the target; positive scrolls up. */
  | { kind: "scroll"; lines: number }
  /** Focus the target (a click), type `text`, and press Enter when `submit`. */
  | { kind: "type"; text: string; submit?: boolean };

export interface UiActOutcome {
  /** One line for the answer, e.g. `clicked #craft; the panel took the mouse-down on it`. */
  summary: string;
  /** Where the action aimed, GUI-scaled. */
  point?: Point;
}

/** A replayable statement for a recorded action. */
export interface UiCodegen {
  imports: Array<{ from: string; names: string[] }>;
  /** One or more statements with `client` (the adapter's Client handle) in scope. */
  code: string;
}

/** `actionable`: on screen, drawn, enabled and hittable. `absent`: not there, or not drawn. */
export type UiWaitState = "actionable" | "absent";

export interface UiCallOptions {
  /** In-game budget for whatever waiting the call does; default 10000. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A UI wait that ran out of its in-game budget. `last` is what the game's check last saw, when it said;
 * `detail` puts that in one line. Anything else that goes wrong in a wait is thrown as it is.
 */
export class UiWaitTimeoutError extends Error {
  readonly elapsedMs: number;
  readonly detail?: string;
  readonly last?: unknown;

  constructor(message: string, options: { elapsedMs: number; detail?: string; last?: unknown; cause?: unknown }) {
    super(options.detail === undefined ? message : `${message}; ${options.detail}`, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "UiWaitTimeoutError";
    this.elapsedMs = options.elapsedMs;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.last !== undefined) this.last = options.last;
  }
}

export interface UiAdapter<Client = unknown, Probe = unknown, State = unknown> {
  id: string;
  /** One sentence spliced into tool descriptions: what the adapter covers and how it selects. */
  summary: string;

  /**
   * Checked once per launch (e.g. the library's classes and members on this build). A reason turns the
   * adapter off for the session instead of failing every read; `undefined` keeps it on.
   */
  verify?(client: Client, options?: UiCallOptions): Promise<string | undefined>;

  read(): UiReadPlan<Probe, State>;

  /** The most stable selector for a node of this read. `fragile` flags positional fallbacks. */
  locate(layer: UiLayer<State>, node: UiNode): { selector: UiSelector; fragile: boolean };
  /** Resolve a selector against a read. */
  match(layer: UiLayer<State>, selector: UiSelector): UiNode | undefined;

  /**
   * Carry the action out with the library's own semantics (waiting in the game until the target is
   * actionable, scrolling it into view, checking a press lands on it). `undefined` (or no `act`) hands it
   * to the host, which re-reads and aims the platform's pointer at the centre of what is drawn.
   */
  act?(client: Client, selector: UiSelector, action: UiAction, options: UiCallOptions): Promise<UiActOutcome | undefined>;

  /**
   * Wait in the game — one task that decides the condition itself, not a TS loop of reads — until the
   * selector's target reaches `state`. Throws {@link UiWaitTimeoutError} when the budget runs out. `last`
   * is this adapter's layer from the host's last read, if any.
   */
  wait(
    client: Client,
    selector: UiSelector,
    state: UiWaitState,
    options: UiCallOptions & { last?: UiLayer<State> },
  ): Promise<{ elapsedMs: number }>;

  /** The statement for a recorded action; `undefined` makes the host fall back to the platform's pointer codegen. */
  codegen(selector: UiSelector, action: UiAction): UiCodegen | undefined;
}

/**
 * What the game prefab provides the host: running probes in the game, and pointer input at a point for
 * actions no adapter carries out itself.
 */
export interface UiPlatform<Client = unknown, Probe = unknown> {
  /** Runs every probe in one in-game task (one client-thread turn); each answers on its own. */
  read(client: Client, probes: Readonly<Record<string, Probe>>, options?: UiCallOptions): Promise<Record<string, UiProbeOutcome>>;
  /** Pointer (and keyboard, for `type`) input at a GUI-scaled point. `scrollIntoView` is not asked of it. */
  point(client: Client, at: Point, action: Exclude<UiAction, { kind: "scrollIntoView" }>, options?: UiCallOptions): Promise<UiActOutcome>;
  /** The statement that replays {@link point}. */
  pointCodegen(at: Point, action: Exclude<UiAction, { kind: "scrollIntoView" }>): UiCodegen | undefined;
}

// An adapter's State is its own business; the host holds adapters of any State.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyUiAdapter<Client = unknown, Probe = unknown> = UiAdapter<Client, Probe, any>;

export function centre(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
