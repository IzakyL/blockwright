/** World ticks per second of real time. */
export const TICKS_PER_SECOND = 20;

/**
 * How fast the world runs at `at` seconds of the finished video, as a multiple of real time: 1 plays at the
 * game's own pace (20 ticks a second of video), 120 packs two minutes of the world into each second. The
 * speed changes evenly between keys and holds before the first and after the last.
 */
export interface SpeedKey {
  at: number;
  speed: number;
}

/** Maps the finished video's time to world ticks. */
export interface Timeline {
  /** World ticks elapsed from the start of the video to `seconds` (fractional). */
  ticksAt(seconds: number): number;
}

/** A timeline from one speed for the whole video, or from speed keys. */
export function timeline(speed: number | readonly SpeedKey[]): Timeline {
  const keys = typeof speed === "number" ? [{ at: 0, speed }] : [...speed].sort((a, b) => a.at - b.at);
  if (keys.length === 0) throw new Error("a timeline needs a speed");
  for (const key of keys) {
    if (!(key.speed >= 0) || !Number.isFinite(key.speed)) throw new Error(`speed at ${key.at}s must be 0 or more`);
  }
  const rate = (seconds: number) => speedAt(keys, seconds) * TICKS_PER_SECOND;
  return {
    ticksAt(seconds: number): number {
      if (seconds <= 0) return 0;
      // The speed is piecewise linear, so the trapezoid between consecutive breakpoints is exact.
      const breaks = [0, ...keys.map((key) => key.at).filter((at) => at > 0 && at < seconds), seconds];
      let ticks = 0;
      for (let i = 1; i < breaks.length; i++) {
        ticks += ((rate(breaks[i - 1]) + rate(breaks[i])) / 2) * (breaks[i] - breaks[i - 1]);
      }
      return ticks;
    },
  };
}

function speedAt(keys: readonly SpeedKey[], seconds: number): number {
  if (seconds <= keys[0].at) return keys[0].speed;
  const last = keys[keys.length - 1];
  if (seconds >= last.at) return last.speed;
  let i = 0;
  while (seconds >= keys[i + 1].at) i++;
  const share = (seconds - keys[i].at) / (keys[i + 1].at - keys[i].at);
  return keys[i].speed + (keys[i + 1].speed - keys[i].speed) * share;
}
