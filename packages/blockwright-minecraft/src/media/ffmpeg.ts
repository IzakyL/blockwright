import { spawn } from "node:child_process";

export interface FfmpegEncodeSpec {
  width: number;
  height: number;
  fps: number;
  output: string;
  /** libx264 preset; default `ultrafast` (the encoder must keep up with the game). */
  preset?: string;
  /** libx264 constant rate factor; default libx264's (23). */
  crf?: number;
}

/**
 * Arguments for an ffmpeg that reads raw frames from stdin — bottom-up RGBA rows as the recorder emits
 * them (alpha ignored) — and writes H.264 in an MP4 with the index up front (`+faststart`). Odd sizes are
 * cropped to even ones, which yuv420p needs.
 */
export function ffmpegEncodeArgs(spec: FfmpegEncodeSpec): string[] {
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb0", "-s", `${spec.width}x${spec.height}`, "-framerate", String(spec.fps),
    "-i", "pipe:0",
    "-vf", "vflip,crop=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-preset", spec.preset ?? "ultrafast",
    ...(spec.crf !== undefined ? ["-crf", String(spec.crf)] : []),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    spec.output,
  ];
}

export interface FfmpegMuxSpec {
  video: string;
  /** A float32 wav as an audio recording writes it. */
  audio: string;
  sampleRate: number;
  channels: number;
  /** Bytes of the audio file to skip: its header plus the samples before the video's first frame. */
  skipBytes: number;
  /** Seconds of silence before the audio, when it started after the video's first frame. */
  delaySeconds?: number;
  /** Audio to take, in seconds (the video's duration). */
  durationSeconds: number;
  output: string;
}

/**
 * Arguments for muxing an audio recording into a finished video: the wav is read as raw float32 from
 * `skipBytes` (so the start is sample exact), delayed by `delaySeconds`, the video is copied, the audio
 * encoded to AAC, and the index put up front.
 */
export function ffmpegMuxArgs(spec: FfmpegMuxSpec): string[] {
  const delay = spec.delaySeconds ?? 0;
  return [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", spec.video,
    ...(delay > 0 ? ["-itsoffset", delay.toFixed(6)] : []),
    "-f", "f32le", "-ar", String(spec.sampleRate), "-ac", String(spec.channels),
    "-skip_initial_bytes", String(Math.max(0, Math.floor(spec.skipBytes))),
    "-t", Math.max(0, spec.durationSeconds - delay).toFixed(6),
    "-i", spec.audio,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart",
    spec.output,
  ];
}

export interface WavFormat {
  sampleRate: number;
  channels: number;
  /** Bytes of sample data after the header. */
  dataBytes: number;
}

/** Bytes of the header {@link wavHeader} writes. */
export const WAV_HEADER_BYTES = 44;

/** The header of a float32 (IEEE float) RIFF/WAVE file. */
export function wavHeader(format: WavFormat): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const frameBytes = 4 * format.channels;
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + format.dataBytes, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(format.sampleRate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(format.dataBytes, 40);
  return header;
}

/** Byte offset within float32 sample data (whole sample frames) for `seconds` into it. */
export function audioBytesAt(seconds: number, sampleRate: number, channels: number): number {
  return Math.max(0, Math.floor(seconds * sampleRate)) * 4 * channels;
}

export interface FfmpegOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Runs ffmpeg to completion; resolves with its exit and stderr (rejects only when it cannot start). */
export function runFfmpeg(ffmpeg: string, args: readonly string[]): Promise<FfmpegOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      if (stderr.length < 64_000) stderr += text;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr: stderr.trim() }));
  });
}

/** One line describing a failed ffmpeg. */
export function describeFfmpegFailure(what: string, outcome: FfmpegOutcome): string {
  const status = outcome.signal ? `signal ${outcome.signal}` : `exit ${outcome.code}`;
  const stderr = outcome.stderr ? `: ${outcome.stderr.split("\n").slice(0, 8).join(" | ")}` : "";
  return `${what} (${status})${stderr}`;
}
