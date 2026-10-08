import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Run, type Output, type TaskSpec } from "@izakyl/blockwright-client";
import { FakeInstance, type FakeAnswer } from "../core/fake-instance.test.js";
import { media, MEDIA, minecraft, MinecraftTaskError, SyncLedger } from "../index.js";
import { audioBytesAt, ffmpegEncodeArgs, ffmpegMuxArgs, WAV_HEADER_BYTES, wavHeader } from "../internal.js";

/** A fake whose answers may include binary outputs: `{ $bytes: Buffer, meta }`. */
class BinaryFake extends FakeInstance {
  override run<T = unknown>(task: TaskSpec): Run<T> {
    this.tasks.push(task);
    const answer: FakeAnswer = this.answer(task);
    return new Run<T>((controller) => {
      queueMicrotask(() => {
        for (const value of answer.outputs ?? []) {
          const binary = value as { $bytes?: Buffer; meta?: unknown };
          if (binary && typeof binary === "object" && binary.$bytes) {
            controller.output({ kind: "bytes", data: binary.$bytes, meta: binary.meta } as Output<T>);
          } else {
            controller.output({ kind: "json", value } as Output<T>);
          }
        }
        controller.end(answer.end ?? { status: "ok" });
      });
      return { cancel: async () => {} };
    });
  }
}

function clientOf(answer: (task: TaskSpec) => FakeAnswer) {
  const fake = new BinaryFake("client", answer);
  return { fake, client: minecraft.client(fake, { sync: new SyncLedger() }) };
}

function gradient(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 7) & 0xff;
      rgba[i + 1] = (y * 13) & 0xff;
      rgba[i + 2] = (x * y) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

test("PNG encoding round-trips through the decoder, and is a valid PNG to ffprobe", () => {
  const image = { width: 37, height: 21, rgba: gradient(37, 21) };
  const png = media.encodePng(image);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  const decoded = media.decodePng(png);
  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 21);
  assert.ok(decoded.rgba.equals(image.rgba));
  assert.ok(media.distinctColors(decoded) > 50);
  assert.equal(media.distinctColors({ width: 4, height: 4, rgba: Buffer.alloc(64) }), 1);
  assert.throws(() => media.encodePng({ width: 2, height: 2, rgba: Buffer.alloc(3) }), RangeError);
  if (hasFfmpeg) {
    const dir = mkdtempSync(join(tmpdir(), "bw-png-"));
    try {
      writeFileSync(join(dir, "a.png"), png);
      const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(dir, "a.png")], { encoding: "utf8" });
      assert.equal(probe.trim(), "37,21");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("ffmpeg arguments: raw bottom-up frames in, H.264 with faststart out; mux skips to a sample-exact byte", () => {
  const encode = ffmpegEncodeArgs({ width: 854, height: 481, fps: 30, output: "/tmp/x.mp4" });
  const at = (flag: string) => encode[encode.indexOf(flag) + 1];
  assert.equal(at("-f"), "rawvideo");
  assert.equal(at("-pix_fmt"), "rgb0");
  assert.equal(at("-s"), "854x481");
  assert.equal(at("-framerate"), "30");
  assert.equal(at("-i"), "pipe:0");
  assert.match(at("-vf")!, /^vflip,crop=/);
  assert.equal(at("-c:v"), "libx264");
  assert.equal(at("-preset"), "ultrafast");
  assert.ok(!encode.includes("-crf"));
  assert.equal(at("-movflags"), "+faststart");
  assert.equal(encode.at(-1), "/tmp/x.mp4");
  const tuned = ffmpegEncodeArgs({ width: 2, height: 2, fps: 60, output: "o.mp4", preset: "veryfast", crf: 18 });
  assert.equal(tuned[tuned.indexOf("-crf") + 1], "18");
  assert.equal(tuned[tuned.indexOf("-preset") + 1], "veryfast");

  const mux = ffmpegMuxArgs({ video: "v.mp4", audio: "a.wav", sampleRate: 48_000, channels: 2, skipBytes: 1234.9, durationSeconds: 2.5, output: "o.mp4" });
  const m = (flag: string) => mux[mux.indexOf(flag) + 1];
  assert.equal(m("-f"), "f32le");
  assert.equal(m("-ar"), "48000");
  assert.equal(m("-ac"), "2");
  assert.equal(m("-skip_initial_bytes"), "1234");
  assert.equal(m("-t"), "2.500000");
  assert.ok(!mux.includes("-itsoffset"));
  assert.ok(mux.indexOf("-t") < mux.lastIndexOf("-i"), "input options precede the audio input");
  assert.deepEqual(mux.filter((arg, i) => mux[i - 1] === "-map"), ["0:v:0", "1:a:0"]);
  assert.equal(m("-c:v"), "copy");
  assert.equal(m("-movflags"), "+faststart");

  const delayed = ffmpegMuxArgs({ video: "v.mp4", audio: "a.wav", sampleRate: 48_000, channels: 2, skipBytes: 44, delaySeconds: 0.5, durationSeconds: 2.5, output: "o.mp4" });
  const d = (flag: string) => delayed[delayed.indexOf(flag) + 1];
  assert.equal(d("-itsoffset"), "0.500000");
  assert.equal(d("-t"), "2.000000", "the delay is part of the video's duration");
  assert.ok(delayed.indexOf("-itsoffset") > delayed.indexOf("v.mp4") && delayed.indexOf("-itsoffset") < delayed.lastIndexOf("-i"));

  assert.equal(audioBytesAt(1, 48_000, 2), 384_000);
  assert.equal(audioBytesAt(0.0000301, 48_000, 2), 8, "whole sample frames only");
  assert.equal(audioBytesAt(-1, 48_000, 2), 0);
});

test("the wav header describes float32 samples ffprobe reads back", { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bw-wav-"));
  try {
    const file = join(dir, "a.wav");
    const data = sine(48_000, 2, 0.25);
    writeFileSync(file, Buffer.concat([wavHeader({ sampleRate: 48_000, channels: 2, dataBytes: data.length }), data]));
    assert.equal(WAV_HEADER_BYTES, 44);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,duration", "-of", "csv=p=0", file], { encoding: "utf8" });
    assert.equal(probe.trim(), "pcm_f32le,48000,2,0.250000");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** `seconds` of a 440 Hz sine, interleaved float32. */
function sine(sampleRate: number, channels: number, seconds: number, from = 0): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const out = Buffer.alloc(frames * channels * 4);
  for (let i = 0; i < frames; i++) {
    const value = 0.5 * Math.sin((2 * Math.PI * 440 * (from + i)) / sampleRate);
    for (let c = 0; c < channels; c++) out.writeFloatLE(value, (i * channels + c) * 4);
  }
  return out;
}

/** An audio chunk as AudioRecorder emits it: `frames` of sine from `position`. */
function audioChunk(position: number, frames: number, nanoTime: number) {
  return { $bytes: sine(48_000, 2, frames / 48_000, position), meta: { position, frames, sampleRate: 48_000, channels: 2, nanoTime } };
}

test("screenshot sends the camera and options, encodes the raw frame to PNG and writes it", async () => {
  const rgba = gradient(8, 4);
  const { fake, client } = clientOf(() => ({
    outputs: [
      { $bytes: rgba, meta: { width: 8, height: 4, frame: 12 } },
      { width: 8, height: 4, frame: 12, sourceWidth: 16, sourceHeight: 8, terrain: { settled: true, sections: "9/9", frames: 20 } },
    ],
  }));
  const dir = mkdtempSync(join(tmpdir(), "bw-shot-"));
  try {
    const camera = { position: { x: 1, y: 70, z: 2 }, yaw: 45, pitch: 30 };
    const shot = await media.screenshot(client, { camera, maxWidth: 8, path: join(dir, "sub", "shot.png") });
    assert.deepEqual(fake.ensured.at(-1), ["blockwright.minecraft.core", "blockwright.minecraft.core.client", MEDIA.name]);
    const task = fake.tasksWith("Screenshots.capture")[0]!;
    assert.equal(task.thread, "client");
    assert.deepEqual(task.args, { settleMs: 5000, camera, maxWidth: 8 });
    assert.equal(task.timeoutMs, 20_000);
    assert.equal(shot.width, 8);
    assert.equal(shot.sourceWidth, 16);
    assert.deepEqual(shot.terrain, { settled: true, sections: "9/9", frames: 20 });
    assert.ok(media.decodePng(shot.png).rgba.equals(rgba));
    assert.equal(statSync(shot.path!).size, shot.png.length);
    assert.match(shot.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const { client: failing } = clientOf(() => ({ end: { status: "error", error: { code: "unavailable", message: "the client is not in a world" } } }));
  await assert.rejects(media.screenshot(failing), (error: unknown) => error instanceof MinecraftTaskError && error.code === "unavailable" && error.task === "media.screenshot");
});

test("draw capture: start waits for the game to listen, stop signals it by id; a frame window is one run", async () => {
  const result = { channel: "hud", frames: [{ index: 3, entries: [{ kind: "text", text: "hi", x: 1, y: 2, width: 10, height: 9, color: -1 }] }], frameCount: 1, entryCount: 1, droppedEntries: 0, batches: [] };
  const { fake, client } = clientOf((task) => {
    if (task.source.includes("LongRuns.stop")) return { outputs: [true] };
    return { outputs: [{ started: { channel: "hud" } }, result] };
  });
  const capture = await media.startDraws(client, { shapes: true, maxFrames: 2 });
  assert.match(capture.id, /^draw-/);
  const start = fake.tasksWith("DrawCapture.capture")[0]!;
  assert.deepEqual(start.args, { skipFrames: 0, channel: "hud", maxFrames: 2, shapes: true, id: capture.id });
  assert.equal(start.timeoutMs, 0);
  assert.deepEqual(await capture.stop(), result);

  await media.draws(client, { channel: "world", frames: 3 });
  const window = fake.tasksWith("DrawCapture.capture")[1]!;
  assert.deepEqual(window.args, { channel: "world", maxFrames: 8, frames: 3 });
  assert.equal(window.timeoutMs, 30_000);
});

test("sound capture and waitForSounds: filters, in-game budget and the capture id reach the game", async () => {
  const event = { id: "minecraft:block.note_block.pling", source: "master" };
  const { fake, client } = clientOf((task) => {
    if (task.source.includes("SoundCapture.capture")) return { outputs: [{ started: { id: "x" } }, { events: [event], eventCount: 1, droppedEvents: 0 }] };
    if (task.source.includes("SoundCapture.waitFor")) return { outputs: [{ events: [event], ticks: 3, elapsedMs: 150 }] };
    return { outputs: [true] };
  });
  const capture = await media.startSounds(client, { maxEvents: 10 });
  const waited = await capture.waitFor({ count: 2, pattern: /note_block\.\w+/, id: "minecraft:block.note_block.pling", timeoutMs: 3000 });
  assert.equal(waited.ticks, 3);
  const wait = fake.tasksWith("SoundCapture.waitFor")[0]!;
  assert.deepEqual(wait.args, {
    count: 2, wait: { timeoutMs: 3000 }, id: capture.id,
    ids: ["minecraft:block.note_block.pling"], pattern: "note_block\\.\\w+",
  });
  assert.equal(wait.timeoutMs, 8000);
  await media.waitForSounds(client, { source: "master" });
  assert.deepEqual(fake.tasksWith("SoundCapture.waitFor")[1]!.args, { count: 1, wait: { timeoutMs: 10_000 }, source: "master" });
  const stopped = await capture.stop();
  assert.equal(stopped.events.filter((played) => played.id === "minecraft:block.note_block.pling").length, 1);
});

test("recording: frames fill fixed time slots (gaps repeat the last frame) and ffmpeg writes a playable MP4", { skip: !hasFfmpeg }, async () => {
  const width = 16;
  const height = 10;
  const frame = (shade: number, time: number, index: number) => ({
    $bytes: Buffer.alloc(width * height * 4, shade),
    meta: { index, time, nanoTime: 1_000 + time, width, height },
  });
  const { fake, client } = clientOf((task) => {
    if (task.source.includes("FrameRecorder.record")) {
      return {
        outputs: [
          { started: { width, height, fps: 10, startNanos: 1_000 } },
          frame(10, 0, 1),
          frame(80, 100_000_000, 5),
          frame(160, 400_000_000, 9), // slots 2 and 3 are repeats
          { width, height, fps: 10, frames: 3, captured: 3, dropped: 0, skipped: 0, durationMs: 400, reason: null },
        ],
      };
    }
    return { outputs: [false] };
  });
  const dir = mkdtempSync(join(tmpdir(), "bw-rec-"));
  try {
    // No `audio`: a silent video by default, and no audio recording is started.
    const recording = await media.record(client, { path: join(dir, "out", "clip.mp4"), fps: 10 });
    assert.equal(recording.width, width);
    assert.equal(fake.tasksWith("AudioRecorder.record").length, 0, "audio is opt-in");
    const task = fake.tasksWith("FrameRecorder.record")[0]!;
    assert.deepEqual(task.args, { id: recording.id, fps: 10, dropPolicy: "drop-newest" });
    assert.equal(task.timeoutMs, 0);
    const result = await recording.stop();
    assert.equal(result.frames, 5);
    assert.equal(result.repeated, 2);
    assert.equal(result.captured, 3);
    assert.equal(result.durationMs, 500);
    assert.equal(result.audio, undefined);
    const probe = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_name,width,height,nb_read_frames", "-of", "csv=p=0", result.path], { encoding: "utf8" });
    assert.equal(probe.trim(), "h264,16,10,5");
    assert.equal(await recording.stop(), result, "stop is idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audio recording: chunks land at their sample position, a lost chunk is silence, the header is final", async () => {
  const { fake, client } = clientOf((task) => {
    if (task.source.includes("AudioRecorder.record")) {
      return {
        outputs: [
          { started: { startNanos: 500 } },
          audioChunk(96_000, 4_800, 1_000),
          // 96_000 + 4_800 .. + 9_600 was dropped
          audioChunk(105_600, 4_800, 1_000 + 200_000_000),
          { sampleRate: 48_000, channels: 2, frames: 9_600, firstPosition: 96_000, firstNanos: 1_000, dropped: 1, durationMs: 200, reason: null },
        ],
      };
    }
    return { outputs: [false] };
  });
  const dir = mkdtempSync(join(tmpdir(), "bw-audio-"));
  try {
    const recording = await media.recordAudio(client, { path: join(dir, "out", "a.wav"), maxDurationMs: 5_000 });
    const task = fake.tasksWith("AudioRecorder.record")[0]!;
    assert.deepEqual(task.args, { id: recording.id, dropPolicy: "drop-newest", maxDurationMs: 5_000 });
    assert.equal(task.timeoutMs, 0);
    const result = await recording.stop();
    assert.deepEqual(result, {
      path: join(dir, "out", "a.wav"), sampleRate: 48_000, channels: 2, frames: 14_400, silenced: 4_800, dropped: 1, durationMs: 300, firstNanos: 1_000,
    });
    const file = readFileSync(result.path);
    assert.equal(file.length, WAV_HEADER_BYTES + 14_400 * 8);
    assert.equal(file.readUInt32LE(40), 14_400 * 8, "data size");
    assert.equal(file.readUInt16LE(20), 3, "IEEE float");
    const gap = file.subarray(WAV_HEADER_BYTES + 4_800 * 8, WAV_HEADER_BYTES + 9_600 * 8);
    assert.ok(gap.every((byte) => byte === 0), "the lost chunk's span is silence");
    assert.ok(file.subarray(WAV_HEADER_BYTES + 9_600 * 8).some((byte) => byte !== 0));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recording: the audio span that matches the video, by the game's clock, is muxed in", { skip: !hasFfmpeg }, async () => {
  const width = 16;
  const height = 10;
  const frameAt = (index: number, time: number) => ({
    $bytes: Buffer.alloc(width * height * 4, 40 * index),
    meta: { index, time, nanoTime: 5_000_000_000 + time, width, height },
  });
  // Audio starts 0.2 s before the first frame: that much is cut.
  const audioStart = 5_000_000_000 - 200_000_000;
  const { client } = clientOf((task) => {
    if (task.source.includes("AudioRecorder.record")) {
      return {
        outputs: [
          { started: { startNanos: audioStart } },
          ...Array.from({ length: 12 }, (_, i) => audioChunk(i * 4_800, 4_800, audioStart + i * 100_000_000)),
          { sampleRate: 48_000, channels: 2, frames: 57_600, firstPosition: 0, firstNanos: audioStart, dropped: 0, durationMs: 1_200, reason: null },
        ],
      };
    }
    if (task.source.includes("FrameRecorder.record")) {
      return {
        outputs: [
          { started: { width, height, fps: 10, startNanos: 5_000_000_000 } },
          ...Array.from({ length: 10 }, (_, i) => frameAt(i + 1, i * 100_000_000)),
          { width, height, fps: 10, frames: 10, captured: 10, dropped: 0, skipped: 0, durationMs: 900, reason: null },
        ],
      };
    }
    return { outputs: [false] };
  });
  const dir = mkdtempSync(join(tmpdir(), "bw-rec-audio-"));
  try {
    const recording = await media.record(client, { path: join(dir, "clip.mp4"), fps: 10, audio: true });
    const result = await recording.stop();
    assert.equal(result.audio?.muxed, true, result.audio?.reason);
    assert.equal(result.audio?.offsetSeconds, 0.2);
    assert.equal(result.audio?.sampleRate, 48_000);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "csv=p=0", result.path], { encoding: "utf8" });
    assert.deepEqual(probe.trim().split("\n").sort(), ["aac,audio", "h264,video"]);
    const leftovers = execFileSync("ls", ["-A", dir], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(leftovers, ["clip.mp4"], "the intermediate video and wav are removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
