/**
 * How a segment's progress is shaped: `linear` keeps an even pace, `in` starts slow, `out` ends slow, `inOut`
 * does both (the camera comes to rest at each end), `hold` stays on the segment's first value and cuts to the
 * next at its end. A function maps 0..1 to 0..1 itself.
 */
export type Ease = "linear" | "in" | "out" | "inOut" | "hold" | ((t: number) => number);

/** `t` (clamped to 0..1) shaped by `kind`. */
export function ease(kind: Ease | undefined, t: number): number {
  const u = Math.min(1, Math.max(0, t));
  if (typeof kind === "function") return kind(u);
  switch (kind ?? "linear") {
    case "linear":
      return u;
    case "in":
      return u * u * u;
    case "out":
      return 1 - (1 - u) ** 3;
    case "inOut":
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    case "hold":
      return u < 1 ? 0 : 1;
  }
  throw new Error(`unknown ease ${String(kind)}`);
}
