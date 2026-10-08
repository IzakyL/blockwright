import { mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MinecraftClient } from "../core/index.js";
import { LongRun, longRunId, type BytesOutput } from "../core/long-run.js";
import { WAV_HEADER_BYTES, wavHeader } from "./ffmpeg.js";
import { mediaTask } from "./module.js";
import type { FrameDropPolicy } from "./recording.js";

export interface AudioRecordingOptions {
  /** The wav to write (directories are created): float32 samples as the client mixes them. */
  path: string;
  /** Stop by itself after this long (then `stop()` just finalises). */
  maxDurationMs?: number;
  /**
   * Default `drop-newest`: the client's audio never waits; a chunk that finds the queue full is lost and its
   * span is written as silence, so the file keeps real time. `block` stalls the client's audio instead.
   */
  dropPolicy?: FrameDropPolicy;
}

export interface AudioRecordingResult {
  /** Absolute path of the wav. */
  path: string;
  sampleRate: number;
  channels: number;
  /** Sample frames in the file (captured plus silence written for lost chunks). */
  frames: number;
  /** Sample frames written as silence because their chunk was lost (drop policy). */
  silenced: number;
  /** Chunks lost in the connection's binary queue. */
  dropped: number;
  durationMs: number;
  /**
   * When the first sample was due, as the game's `System.nanoTime()`: the clock frame recordings stamp their
   * frames with, so the two line up. Undefined when no audio arrived.
   */
  firstNanos?: number;
}

/** A live audio recording: the client's mix streams into a wav until {@link stop}. */
export interface AudioRecording {
  readonly id: string;
  readonly path: string;
  /** Stops the capture, writes the header and answers the finished file. */
  stop(): Promise<AudioRecordingResult>;
  /** Cancels without a file: the capture ends and the partial file is removed. */
  discard(): Promise<void>;
}

interface AudioSummary {
  sampleRate: number;
  channels: number;
  frames: number;
  firstPosition: number;
  firstNanos: number;
  dropped: number;
  durationMs: number;
  reason: string | null;
}

interface ChunkMeta {
  position: number;
  frames: number;
  sampleRate: number;
  channels: number;
  nanoTime: number;
}

const RECORD_AUDIO = mediaTask<Record<string, unknown>, AudioSummary>("media.recordAudio", "AudioRecorder.record", { timeoutMs: 0 });

/**
 * Starts recording the client's audio mix to a wav. Resolves once the game listens. Every client renders its
 * mix into a loopback device in real time, so there is always something to record (silence when nothing
 * plays); chunks are placed by their sample position, so the file keeps real time even when some are lost.
 */
export async function startAudioRecording(client: MinecraftClient, options: AudioRecordingOptions): Promise<AudioRecording> {
  const path = resolve(options.path);
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "w");
  const id = longRunId("audio");
  const args: Record<string, unknown> = { id, dropPolicy: options.dropPolicy ?? "drop-newest" };
  if (options.maxDurationMs !== undefined) args.maxDurationMs = options.maxDurationMs;

  const state = {
    format: undefined as { sampleRate: number; channels: number; firstPosition: number; firstNanos: number } | undefined,
    end: 0,
    written: 0,
    closed: false,
  };

  const onChunk = async (output: BytesOutput) => {
    const meta = output.meta as ChunkMeta;
    state.format ??= { sampleRate: meta.sampleRate, channels: meta.channels, firstPosition: meta.position, firstNanos: meta.nanoTime };
    const frameBytes = 4 * state.format.channels;
    const at = (meta.position - state.format.firstPosition) * frameBytes;
    if (at < 0 || state.closed) return;
    // Positional writes: a lost chunk leaves a hole that reads back as zeros, i.e. silence.
    await file.write(output.data, 0, output.data.length, WAV_HEADER_BYTES + at);
    state.end = Math.max(state.end, at + output.data.length);
    state.written += meta.frames;
  };

  let session: LongRun<AudioSummary>;
  try {
    const run = await client.start(RECORD_AUDIO, args);
    session = new LongRun<AudioSummary>(client, RECORD_AUDIO.name, "audio", id, run, onChunk);
    await session.started;
  } catch (error) {
    await closeAndRemove(file, path);
    throw error;
  }

  let finished: Promise<AudioRecordingResult> | undefined;
  const finish = async (): Promise<AudioRecordingResult> => {
    let summary: AudioSummary;
    try {
      summary = await session.stop();
    } catch (error) {
      await closeAndRemove(file, path);
      throw error;
    }
    const sampleRate = state.format?.sampleRate ?? summary.sampleRate;
    const channels = state.format?.channels ?? summary.channels;
    const frameBytes = 4 * Math.max(1, channels);
    const frames = state.end / frameBytes;
    try {
      await file.write(wavHeader({ sampleRate, channels, dataBytes: state.end }), 0, WAV_HEADER_BYTES, 0);
      await file.truncate(WAV_HEADER_BYTES + state.end);
    } finally {
      state.closed = true;
      await file.close();
    }
    if (summary.reason) throw new Error(`the audio recording stopped: ${summary.reason}`);
    return {
      path,
      sampleRate,
      channels,
      frames,
      silenced: frames - state.written,
      dropped: summary.dropped,
      durationMs: sampleRate > 0 ? Math.round((frames * 1000) / sampleRate) : 0,
      ...(state.format ? { firstNanos: state.format.firstNanos } : {}),
    };
  };

  return {
    id,
    path,
    stop: () => (finished ??= finish()),
    discard: async () => {
      await session.cancel();
      state.closed = true;
      await closeAndRemove(file, path);
    },
  };
}

async function closeAndRemove(file: FileHandle, path: string): Promise<void> {
  await file.close().catch(() => {});
  await rm(path, { force: true });
}
