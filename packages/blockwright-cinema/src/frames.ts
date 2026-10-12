/**
 * The mean of equally sized RGBA frames, channel by channel (rounded), for motion blur: the samples of one
 * shutter laid over each other.
 */
export function blendFrames(frames: readonly Buffer[]): Buffer {
  if (frames.length === 0) throw new Error("nothing to blend");
  if (frames.length === 1) return frames[0];
  const length = frames[0].length;
  if (frames.some((frame) => frame.length !== length)) throw new Error("blended frames differ in size");
  const sums = new Uint32Array(length);
  for (const frame of frames) {
    for (let i = 0; i < length; i++) sums[i] += frame[i];
  }
  const out = Buffer.allocUnsafe(length);
  const half = frames.length / 2;
  for (let i = 0; i < length; i++) out[i] = Math.floor((sums[i] + half) / frames.length);
  return out;
}

/** The six-digit file name of frame `index` in a frame directory (`000042.png`). */
export function frameName(index: number): string {
  return `${String(index).padStart(6, "0")}.png`;
}

export interface EncodeFramesSpec {
  /** Directory of `000000.png`, `000001.png`, ... */
  frames: string;
  fps: number;
  output: string;
  /** libx264 CRF; default 16 (the frames are the master, so keep it near lossless). */
  crf?: number;
  /** libx264 preset; default `slow` (nothing is waiting on the encoder). */
  preset?: string;
}

/**
 * ffmpeg arguments that encode a frame directory to H.264 in an MP4 with the index up front. Odd sizes are
 * cropped to even ones, which yuv420p needs.
 */
export function encodeFramesArgs(spec: EncodeFramesSpec): string[] {
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(spec.fps), "-start_number", "0",
    "-i", `${spec.frames}/%06d.png`,
    "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-preset", spec.preset ?? "slow", "-crf", String(spec.crf ?? 16),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    spec.output,
  ];
}
