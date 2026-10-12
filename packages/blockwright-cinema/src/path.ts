import type { CameraPose, Vec3 } from "@izakyl/blockwright-minecraft";
import { ease, type Ease } from "./ease.js";

/**
 * One keyframe of a camera path, at `at` seconds of the finished video. The camera either looks at `target`
 * (a point that is interpolated like the position, so an orbit keeps its subject centred) or is turned by
 * `yaw` and `pitch` (Minecraft's: yaw 0 faces south, positive pitch looks down). `ease` shapes the segment
 * from this keyframe to the next.
 */
export interface Keyframe {
  at: number;
  position: Vec3;
  target?: Vec3;
  yaw?: number;
  pitch?: number;
  /** Field of view, 30..110; keyframes without one keep the game's. */
  fov?: number;
  ease?: Ease;
}

export interface CameraPathOptions {
  /**
   * `smooth` (default) passes through every keyframe with a velocity that carries on across it (a cubic
   * Hermite curve with tangents taken from the neighbouring keyframes and their times, so an uneven spacing
   * does not make the camera lurch); `linear` goes straight from one keyframe to the next.
   */
  curve?: "smooth" | "linear";
  /** Put on every pose, so a capture refuses to shoot from the wrong dimension. */
  dimension?: string;
}

/** A camera path through keyframes, sampled at any time of the finished video. */
export interface CameraPath {
  /** The first and last keyframe's time, in seconds; before and after them the path holds its ends. */
  readonly start: number;
  readonly end: number;
  /** The pose at `seconds` of the finished video. */
  at(seconds: number): CameraPose;
}

const FOV_MIN = 30;
const FOV_MAX = 110;

type Channels = number[];

/**
 * Builds a path through `keys` (sorted by time here; two keyframes may not share a time). Yaw is unwound so
 * each turn takes the short way round, unless the keyframes look at targets, which decide it themselves.
 */
export function cameraPath(keys: readonly Keyframe[], options: CameraPathOptions = {}): CameraPath {
  if (keys.length === 0) throw new Error("a camera path needs at least one keyframe");
  const sorted = [...keys].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].at > sorted[i - 1].at)) throw new Error(`two keyframes at ${sorted[i].at}s`);
  }
  const targeted = sorted.every((key) => key.target !== undefined);
  const withFov = sorted.some((key) => key.fov !== undefined);
  if (withFov && !sorted.every((key) => key.fov !== undefined)) {
    throw new Error("give every keyframe a fov, or none (a path cannot fall back to the game's mid-way)");
  }

  let lastYaw: number | undefined;
  const rows: Channels[] = sorted.map((key, index) => {
    const row = [key.position.x, key.position.y, key.position.z];
    if (targeted) {
      row.push(key.target!.x, key.target!.y, key.target!.z);
    } else {
      const angles = key.yaw !== undefined && key.pitch !== undefined
        ? { yaw: key.yaw, pitch: key.pitch }
        : key.target !== undefined
          ? anglesTowards(key.position, key.target)
          : undefined;
      if (!angles) throw new Error(`keyframe ${index} (at ${key.at}s) needs a target, or a yaw and a pitch`);
      const yaw = lastYaw === undefined ? angles.yaw : lastYaw + wrap180(angles.yaw - lastYaw);
      lastYaw = yaw;
      row.push(yaw, angles.pitch);
    }
    if (withFov) row.push(key.fov!);
    return row;
  });
  const times = sorted.map((key) => key.at);
  const tangents = options.curve === "linear" ? undefined : hermiteTangents(times, rows);

  const sample = (seconds: number): Channels => {
    if (rows.length === 1 || seconds <= times[0]) return rows[0];
    const last = rows.length - 1;
    if (seconds >= times[last]) return rows[last];
    let i = 0;
    while (seconds >= times[i + 1]) i++;
    const span = times[i + 1] - times[i];
    const u = ease(sorted[i].ease, (seconds - times[i]) / span);
    return rows[i].map((a, channel) => {
      const b = rows[i + 1][channel];
      if (!tangents) return a + (b - a) * u;
      return hermite(a, b, tangents[i][channel] * span, tangents[i + 1][channel] * span, u);
    });
  };

  return {
    start: times[0],
    end: times[times.length - 1],
    at(seconds: number): CameraPose {
      const row = sample(seconds);
      const position = { x: row[0], y: row[1], z: row[2] };
      const angles = targeted
        ? anglesTowards(position, { x: row[3], y: row[4], z: row[5] })
        : { yaw: wrap180(row[3]), pitch: row[4] };
      const fov = withFov ? row[targeted ? 6 : 5] : undefined;
      return {
        position,
        yaw: angles.yaw,
        pitch: Math.min(90, Math.max(-90, angles.pitch)),
        ...(fov !== undefined ? { fov: Math.min(FOV_MAX, Math.max(FOV_MIN, fov)) } : {}),
        ...(options.dimension !== undefined ? { dimension: options.dimension } : {}),
      };
    },
  };
}

/** A pose held for the whole video, as a path. */
export function fixedPath(pose: CameraPose): CameraPath {
  return { start: 0, end: 0, at: () => pose };
}

/** A player's eyes above its feet. */
const EYE_HEIGHT = 1.62;

/** The height of the ground at a block column, for a walk to follow. */
export type Ground = (x: number, z: number) => number;

export interface WalkPathOptions {
  /** A point to turn to at the end: the walk then arrives a second early and turns over that second. */
  look?: Vec3;
  /** The pitch held while walking; default 5 (a little down, as someone watching their step). */
  pitch?: number;
}

/**
 * A walk through `points` on the ground, at an even pace from `from` to `to` seconds, facing the way it goes;
 * each position's height is the ground's there. The poses are a walker's feet and where it looks: move a player
 * along them, and film it with {@link followPath}.
 */
export function walkPath(ground: Ground, points: ReadonlyArray<{ x: number; z: number }>, from: number, to: number,
  options: WalkPathOptions = {}): CameraPath {
  if (points.length === 0) throw new Error("a walk needs at least one point");
  if (!(to > from)) throw new Error(`a walk must end after it starts (from ${from}s to ${to}s)`);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  }
  const total = lengths[lengths.length - 1];
  const pitch = options.pitch ?? 5;
  const arrive = options.look ? Math.max(from + (to - from) / 2, to - 1) : to;
  // A keyframe every two blocks, each at its share of the distance: the pace stays even through the corners
  // and the height follows the ground between the given points.
  const steps = Math.max(1, Math.ceil(total / 2));
  const keys: Keyframe[] = [];
  let yaw = 0;
  for (let step = 0; step <= steps; step++) {
    const along = (total * step) / steps;
    let i = Math.min(1, points.length - 1);
    while (i < points.length - 1 && lengths[i] < along) i++;
    const a = points[Math.max(0, i - 1)], b = points[i];
    const span = lengths[i] - lengths[Math.max(0, i - 1)];
    const share = span > 1e-9 ? (along - lengths[Math.max(0, i - 1)]) / span : 0;
    const x = a.x + (b.x - a.x) * share, z = a.z + (b.z - a.z) * share;
    if (Math.hypot(b.x - a.x, b.z - a.z) > 1e-6) yaw = anglesTowards({ x: a.x, y: 0, z: a.z }, { x: b.x, y: 0, z: b.z }).yaw;
    keys.push({ at: from + ((arrive - from) * step) / steps, position: { x, y: ground(Math.floor(x), Math.floor(z)), z }, yaw, pitch });
  }
  if (options.look) {
    const last = keys[keys.length - 1];
    const angles = anglesTowards({ ...last.position, y: last.position.y + EYE_HEIGHT }, options.look);
    last.ease = "inOut";
    keys.push({ at: to, position: last.position, yaw: angles.yaw, pitch: angles.pitch });
  }
  return cameraPath(keys, { curve: "linear" });
}

/** Someone standing with their feet at `at`, looking at `look`, as a path. */
export function standPath(at: Vec3, look: Vec3): CameraPath {
  return fixedPath({ position: at, ...anglesTowards({ ...at, y: at.y + EYE_HEIGHT }, look) });
}

export interface FollowPathOptions {
  /** Blocks behind the walker, against the way it is going. */
  back: number;
  /** Blocks above its feet. */
  up: number;
  /** Blocks to its right (negative: left); default 0. */
  side?: number;
  fov?: number;
}

/**
 * A camera that keeps a walker in frame from `from` to `to` seconds: once a second it is `back` blocks behind
 * and `up` above where the walker is, looking at its chest, and it moves smoothly between, so it lags a little
 * as a hand-held one would. "Behind" follows the way the walker is going, not the way it faces: a walker that
 * stops and looks round does not swing the camera.
 */
export function followPath(walk: CameraPath, from: number, to: number, options: FollowPathOptions): CameraPath {
  if (!(to >= from)) throw new Error(`a follow must not end before it starts (from ${from}s to ${to}s)`);
  const heading = (t: number) => {
    const here = walk.at(t).position, ahead = walk.at(Math.min(to + 1, t + 1.5)).position;
    const dx = ahead.x - here.x, dz = ahead.z - here.z, length = Math.hypot(dx, dz);
    return length < 0.2 ? undefined : { dx: dx / length, dz: dz / length };
  };
  // Before the walker first moves: the way it will first go, or else the way it faces.
  let going: { dx: number; dz: number } | undefined;
  for (let t = from; t <= to + 1e-9 && !going; t += 0.5) going = heading(t);
  if (!going) {
    const yaw = (walk.at(from).yaw * Math.PI) / 180;
    going = { dx: -Math.sin(yaw), dz: Math.cos(yaw) };
  }
  const side = options.side ?? 0;
  const keys: Keyframe[] = [];
  const key = (t: number) => {
    const here = walk.at(t).position;
    going = heading(t) ?? going!;
    const { dx, dz } = going;
    keys.push({
      at: t,
      position: { x: here.x - dx * options.back - dz * side, y: here.y + options.up, z: here.z - dz * options.back + dx * side },
      target: { x: here.x, y: here.y + 1.2, z: here.z },
      ...(options.fov !== undefined ? { fov: options.fov } : {}),
    });
  };
  for (let t = from; t < to - 1e-9; t += 1) key(t);
  key(to);
  return cameraPath(keys);
}

/** Two paths one after the other, as a cut: `a` before `at` seconds, `b` from then on. */
export function cutTo(a: CameraPath, b: CameraPath, at: number): CameraPath {
  return { start: Math.min(a.start, at), end: Math.max(b.end, at), at: (seconds) => (seconds < at ? a.at(seconds) : b.at(seconds)) };
}

export interface OrbitOptions {
  /** The point the camera circles and looks at. */
  center: Vec3;
  /** Horizontal distance from the centre. */
  radius: number;
  /** The camera's height above the centre. */
  height: number;
  /** The direction the camera faces at the start and the end, as Minecraft yaw (0 faces south). */
  fromYaw: number;
  toYaw: number;
  /** Seconds of the finished video the orbit starts and ends at. */
  start: number;
  end: number;
  fov?: number;
  /** Keyframes per 30 degrees turned, at least 1; default 1. */
  density?: number;
  /** The ease of the whole orbit; default linear (an even turn). */
  ease?: Ease;
}

/**
 * Keyframes for an orbit around `center` (pass them to {@link cameraPath}, alone or among others). The
 * keyframes are spaced evenly; with an `ease` the turn is shaped over the whole orbit, not each segment.
 */
export function orbit(options: OrbitOptions): Keyframe[] {
  const turn = options.toYaw - options.fromYaw;
  const segments = Math.max(1, Math.ceil((Math.abs(turn) / 30) * Math.max(1, options.density ?? 1)));
  const keys: Keyframe[] = [];
  for (let i = 0; i <= segments; i++) {
    const share = i / segments;
    const at = options.start + (options.end - options.start) * share;
    const yaw = options.fromYaw + turn * ease(options.ease, share);
    const radians = (yaw * Math.PI) / 180;
    const forward = { x: -Math.sin(radians), z: Math.cos(radians) };
    keys.push({
      at,
      position: {
        x: options.center.x - forward.x * options.radius,
        y: options.center.y + options.height,
        z: options.center.z - forward.z * options.radius,
      },
      target: options.center,
      ...(options.fov !== undefined ? { fov: options.fov } : {}),
    });
  }
  return keys;
}

/** The yaw and pitch that look from `from` at `to`. */
export function anglesTowards(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}

function wrap180(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * Per keyframe and channel, the rate of change (per second) the curve passes it with: the mean of the
 * slopes on either side, one-sided at the ends (so a two-keyframe path is an even straight move).
 */
function hermiteTangents(times: number[], rows: Channels[]): Channels[] {
  const slope = (i: number, channel: number) => (rows[i + 1][channel] - rows[i][channel]) / (times[i + 1] - times[i]);
  return rows.map((row, i) => row.map((_, channel) => {
    if (rows.length === 1) return 0;
    if (i === 0) return slope(0, channel);
    if (i === rows.length - 1) return slope(i - 1, channel);
    return (slope(i - 1, channel) + slope(i, channel)) / 2;
  }));
}

function hermite(a: number, b: number, ma: number, mb: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * ma + (-2 * u3 + 3 * u2) * b + (u3 - u2) * mb;
}
