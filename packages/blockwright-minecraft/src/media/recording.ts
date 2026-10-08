import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Writable, Readable } from "node:stream";
import type { MinecraftClient } from "../core/index.js";
import { LongRun, longRunId, STOP_GRACE_MS } from "../core/long-run.js";
import { startAudioRecording, type AudioRecording, type AudioRecordingResult } from "./audio.js";
import { audioBytesAt, describeFfmpegFailure, ffmpegEncodeArgs, ffmpegMuxArgs, runFfmpeg, WAV_HEADER_BYTES } from "./ffmpeg.js";
import { mediaTask } from "./module.js";

/** What the game does with a frame when the connection's binary queue is full. */
export type FrameDropPolicy = "drop-newest" | "drop-oldest" | "block";

export interface RecordingOptions {
  /** The MP4 to write (directories are created). */
  path: string;
  /** Frames per second taken from the game and written to the video; default 30. */
  fps?: number;
  /**
   * Record the client's audio mix alongside and mux it into the video; default false (a video without an
   * audio track).
   */
  audio?: boolean;
  /** Stop by itself after this long (then `stop()` just finalises). */
  maxDurationMs?: number;
  /** Stop by itself after this many captured frames. */
  maxFrames?: number;
  /**
   * Default `drop-newest`: the render thread never waits; a frame that finds the queue full is lost and
   * the gap is filled by repeating the previous frame, so the video keeps real time. `block` stalls the
   * game instead (every frame arrives; the game slows down).
   */
  dropPolicy?: FrameDropPolicy;
  /** The ffmpeg executable; default `ffmpeg` on PATH. */
  ffmpeg?: string;
  /** libx264 preset (default `ultrafast`) and CRF (default 23). */
  preset?: string;
  crf?: number;
}

export interface RecordingAudio {
  sampleRate: number;
  channels: number;
  /**
   * Where the video's first frame falls in the audio recording, in seconds: audio before it is cut. Negative
   * when the audio started after the first frame (it is delayed by as much).
   */
  offsetSeconds: number;
  /** Sample frames written as silence because their chunk was lost. */
  silenced: number;
  muxed: boolean;
  /** Why the audio was not muxed. */
  reason?: string;
}

export interface RecordingResult {
  /** Absolute path of the MP4. */
  path: string;
  width: number;
  height: number;
  fps: number;
  /** Frames in the video (captured frames plus repeats that fill gaps). */
  frames: number;
  /** Frames the game read back and sent. */
  captured: number;
  /** Repeats written to fill slots no frame arrived for (the game rendered slower than `fps`, or drops). */
  repeated: number;
  /** Frames lost in the connection's binary queue (drop policy). */
  dropped: number;
  /** Frames the game skipped because the GPU readback was behind. */
  skipped: number;
  /** Video duration in milliseconds. */
  durationMs: number;
  audio?: RecordingAudio;
}

/** A recording that could not produce a video; `result` has what is known. */
export class MinecraftRecordingError extends Error {
  readonly result: Partial<RecordingResult>;

  constructor(message: string, result: Partial<RecordingResult>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MinecraftRecordingError";
    this.result = result;
  }
}

interface RecorderStarted {
  width: number;
  height: number;
  fps: number;
  startNanos: number;
}

interface RecorderSummary {
  width: number;
  height: number;
  fps: number;
  frames: number;
  captured: number;
  dropped: number;
  skipped: number;
  durationMs: number;
  reason: string | null;
}

interface FrameMeta {
  index: number;
  time: number;
  nanoTime: number;
  width: number;
  height: number;
}

const RECORD = mediaTask<Record<string, unknown>, RecorderSummary>("media.record", "FrameRecorder.record", { timeoutMs: 0 });

/** A live recording: frames stream from the game into ffmpeg until {@link stop}. */
export interface FrameRecording {
  readonly id: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /**
   * Stops the game's capture (it drains the frames in flight), closes the encoder, muxes the audio and
   * answers the finished file. Also finalises a recording that stopped by itself (limits).
   */
  stop(): Promise<RecordingResult>;
  /** Cancels without a video: the capture ends, the encoder is killed and partial files are removed. */
  discard(): Promise<void>;
}

type Encoder = ChildProcessByStdio<Writable, null, Readable>;

/**
 * Starts recording the client's framebuffer to an MP4. Resolves once the game captures (its first frame
 * is the video's start). The game reads frames back asynchronously (pixel-pack buffers, no GPU stall)
 * and streams them as binary outputs; ffmpeg (spawned here) encodes them. With `audio: true` the client's
 * audio mix is recorded alongside (see {@link startAudioRecording}); on {@link FrameRecording.stop} the span of
 * it that matches the video, by the game's clock, is muxed in. Without it the video has no audio track.
 */
export async function startRecording(client: MinecraftClient, options: RecordingOptions): Promise<FrameRecording> {
  const path = resolve(options.path);
  const fps = options.fps ?? 30;
  if (!Number.isInteger(fps) || fps < 1 || fps > 240) throw new RangeError(`fps must be an integer in 1..240, got ${fps}`);
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const withAudio = options.audio === true;
  await mkdir(dirname(path), { recursive: true });
  const videoPath = withAudio ? join(dirname(path), `.${basename(path)}.bw-video.mp4`) : path;

  const id = longRunId("recording");
  const args: Record<string, unknown> = { id, fps, dropPolicy: options.dropPolicy ?? "drop-newest" };
  if (options.maxDurationMs !== undefined) args.maxDurationMs = options.maxDurationMs;
  if (options.maxFrames !== undefined) args.maxFrames = options.maxFrames;

  const state = {
    encoder: undefined as Encoder | undefined,
    encoderClosed: undefined as Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined,
    stderr: "",
    failure: undefined as string | undefined,
    started: undefined as RecorderStarted | undefined,
    firstNanos: undefined as number | undefined,
    written: 0,
    repeated: 0,
    last: undefined as Buffer | undefined,
  };

  const writeFrame = async (data: Buffer) => {
    const encoder = state.encoder;
    if (!encoder || state.failure) return;
    if (!encoder.stdin.write(data)) {
      // One shared close promise: a listener per wait would pile up on the child process.
      const ac = new AbortController();
      await Promise.race([once(encoder.stdin, "drain", { signal: ac.signal }).catch(() => {}), state.encoderClosed]);
      ac.abort();
    }
    state.written++;
  };

  let encoderReady!: () => void;
  const ready = new Promise<void>((resolveReady) => {
    encoderReady = resolveReady;
  });

  const onFrame = async (output: { data: Buffer; meta: unknown }) => {
    await ready;
    const meta = output.meta as FrameMeta;
    if (state.firstNanos === undefined) state.firstNanos = meta.nanoTime;
    // Frames go into fixed slots by their capture time, so the video keeps real time whatever was lost.
    const slot = Math.round((meta.time * fps) / 1e9);
    if (slot < state.written) return; // two captures in one slot: keep the first
    while (state.last && state.written < slot) {
      await writeFrame(state.last);
      state.repeated++;
    }
    await writeFrame(output.data);
    state.last = output.data;
  };

  // Audio starts first, so it covers the first frame; the two are lined up by the game's clock at the end.
  const audio = withAudio
    ? await startAudioRecording(client, { path: join(dirname(path), `.${basename(path)}.bw-audio.wav`), ...(options.dropPolicy ? { dropPolicy: options.dropPolicy } : {}) })
    : undefined;
  let session: LongRun<RecorderSummary>;
  let started: RecorderStarted | undefined;
  try {
    const run = await client.start(RECORD, args);
    session = new LongRun<RecorderSummary>(client, RECORD.name, "recording", id, run, onFrame);
    // The encoder must exist before the first frame is handled: start it as soon as the size is known.
    started = (await session.started) as RecorderStarted | undefined;
    if (!started) {
      await session.answer; // throws the run's error
      throw new MinecraftRecordingError("the recorder ended before it started", { path });
    }
  } catch (error) {
    await audio?.discard();
    throw error;
  }
  state.started = started;
  try {
    const encoder = spawn(ffmpeg, ffmpegEncodeArgs({
      width: started.width, height: started.height, fps, output: videoPath,
      ...(options.preset ? { preset: options.preset } : {}),
      ...(options.crf !== undefined ? { crf: options.crf } : {}),
    }), { stdio: ["pipe", "ignore", "pipe"] });
    state.encoder = encoder;
    encoder.stderr.setEncoding("utf8");
    encoder.stderr.on("data", (text: string) => {
      if (state.stderr.length < 64_000) state.stderr += text;
    });
    encoder.stdin.on("error", (error) => {
      state.failure ??= `ffmpeg stopped reading frames: ${error.message}`;
    });
    state.encoderClosed = new Promise((resolveClosed) => {
      encoder.once("error", (error) => {
        state.failure ??= `ffmpeg could not be started (${ffmpeg}): ${error.message}`;
        resolveClosed({ code: null, signal: null });
      });
      encoder.once("close", (code, signal) => resolveClosed({ code, signal }));
    });
    encoderReady();
  } catch (error) {
    encoderReady();
    await session.cancel();
    await audio?.discard();
    throw new MinecraftRecordingError(`ffmpeg could not be started (${ffmpeg}): ${(error as Error).message}`, { path }, error);
  }

  let finished: Promise<RecordingResult> | undefined;

  const finish = async (): Promise<RecordingResult> => {
    let summary: RecorderSummary | undefined;
    let runError: unknown;
    try {
      summary = await session.stop(STOP_GRACE_MS);
    } catch (error) {
      runError = error;
    }
    const encoder = state.encoder!;
    encoder.stdin.end();
    const exit = await withTimeout(state.encoderClosed!, 60_000, () => encoder.kill("SIGKILL"));
    const partial: Partial<RecordingResult> = {
      path,
      width: started.width,
      height: started.height,
      fps,
      frames: state.written,
      repeated: state.repeated,
      durationMs: Math.round((state.written * 1000) / fps),
      ...(summary ? { captured: summary.captured, dropped: summary.dropped, skipped: summary.skipped } : {}),
    };
    const fail = async (message: string, cause?: unknown): Promise<never> => {
      if (videoPath !== path) await rm(videoPath, { force: true });
      await audio?.discard();
      throw new MinecraftRecordingError(message, partial, cause);
    };
    if (state.written === 0) {
      await rm(videoPath, { force: true });
      return fail(runError ? `the recording failed before any frame: ${(runError as Error).message}`
        : "the client rendered no frames while recording, so there is nothing to encode", runError);
    }
    if (state.failure) return fail(state.failure);
    if (exit.code !== 0) {
      return fail(describeFfmpegFailure("ffmpeg did not finish the video", { ...exit, stderr: state.stderr.trim() }));
    }
    if (!(await stat(videoPath).catch(() => undefined))?.size) return fail("ffmpeg wrote an empty video");
    if (runError) return fail(`the recording ended with an error: ${(runError as Error).message}`, runError);
    if (summary?.reason) return fail(`the recording stopped: ${summary.reason}`);

    const result = partial as RecordingResult;
    if (audio) result.audio = await muxAudio(ffmpeg, videoPath, path, audio, state.firstNanos, result.durationMs);
    return result;
  };

  return {
    id,
    path,
    width: started.width,
    height: started.height,
    fps,
    stop: () => (finished ??= finish()),
    discard: async () => {
      await session.cancel();
      state.encoder?.kill("SIGKILL");
      await state.encoderClosed;
      await rm(videoPath, { force: true });
      await audio?.discard();
    },
  };
}

/**
 * Stops the audio recording and muxes the span of it that matches the video: from the first frame's due time
 * (`firstFrameNanos`, the game's clock) for the video's duration. Without a mux the video is kept as is and
 * `reason` says why.
 */
async function muxAudio(
  ffmpeg: string,
  videoPath: string,
  path: string,
  recording: AudioRecording,
  firstFrameNanos: number | undefined,
  durationMs: number,
): Promise<RecordingAudio> {
  let recorded: AudioRecordingResult;
  try {
    recorded = await recording.stop();
  } catch (error) {
    await rename(videoPath, path);
    return { sampleRate: 0, channels: 0, offsetSeconds: 0, silenced: 0, muxed: false, reason: `the audio recording failed: ${(error as Error).message}` };
  }
  const audio: RecordingAudio = {
    sampleRate: recorded.sampleRate,
    channels: recorded.channels,
    offsetSeconds: 0,
    silenced: recorded.silenced,
    muxed: false,
  };
  const keepVideo = async (reason: string) => {
    audio.reason = reason;
    await rename(videoPath, path);
    await rm(recorded.path, { force: true });
    return audio;
  };
  if (recorded.firstNanos === undefined || recorded.frames === 0) {
    return keepVideo("the client rendered no audio while recording (its sound engine may not have started)");
  }
  const offset = firstFrameNanos === undefined ? 0 : (firstFrameNanos - recorded.firstNanos) / 1e9;
  audio.offsetSeconds = offset;
  const skip = audioBytesAt(Math.max(0, offset), recorded.sampleRate, recorded.channels);
  const muxed = join(dirname(path), `.${basename(path)}.bw-muxed.mp4`);
  let outcome;
  try {
    outcome = await runFfmpeg(ffmpeg, ffmpegMuxArgs({
      video: videoPath,
      audio: recorded.path,
      sampleRate: recorded.sampleRate,
      channels: recorded.channels,
      skipBytes: WAV_HEADER_BYTES + skip,
      delaySeconds: Math.max(0, -offset),
      durationSeconds: durationMs / 1000,
      output: muxed,
    }));
  } catch (error) {
    return keepVideo(`ffmpeg could not be started to mux audio: ${(error as Error).message}`);
  }
  if (outcome.code !== 0) {
    await rm(muxed, { force: true });
    return keepVideo(describeFfmpegFailure("muxing the audio failed", outcome));
  }
  await rename(muxed, path);
  await rm(videoPath, { force: true });
  await rm(recorded.path, { force: true });
  audio.muxed = true;
  return audio;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolveLate) => {
    timer = setTimeout(resolveLate, ms);
  });
  const first = await Promise.race([promise.then((value) => ({ value })), late.then(() => undefined)]);
  clearTimeout(timer);
  if (first) return first.value;
  onTimeout();
  return promise;
}
