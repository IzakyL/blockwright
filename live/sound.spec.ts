import { createGameTest, expect } from "@izakyl/blockwright-test";
import { input, media, screen, tick, world } from "@izakyl/blockwright-minecraft";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { LIVE_DIR, liveConfig } from "./helpers";

/**
 * What the client's sound engine played, read field by field (a UI click and a positioned note), an audio
 * recording of the client's mix that holds the notes played while it ran, and a video recording whose muxed
 * audio track carries that mix. (Capture, waits and muxing as such are live/minecraft-media.spec.ts.)
 */

const test = createGameTest({ cwd: LIVE_DIR, config: liveConfig("blockwright.toml") });

const NOTE_EVENT = "minecraft:block.note_block.harp";
const NOTE_SAMPLE = "minecraft:note/harp2";
const NOTE_SUBTITLE = "Note Block plays";
const NOTE_POSITION = { x: 100.5, y: -60, z: 100.5 };
const PLAY_NOTE = `playsound ${NOTE_EVENT} master @a ${NOTE_POSITION.x} ${NOTE_POSITION.y} ${NOTE_POSITION.z} 1 1`;
const OUT = path.join(LIVE_DIR, "test-results", "sound");

test("the sounds a real client played read back with their sample, source, volume and attenuation", async ({ server, client }, testInfo) => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};

  try {
    const uiSounds = await media.startSounds(client, { maxEvents: 128 });
    const status = await uiSounds.status();
    report.status = status;
    expect(status.engineLoaded, "the client opened no OpenAL device, so vanilla plays nothing at all").toBe(true);
    expect(status.capturing).toBe(true);
    expect(status.volumes.master).toBeGreaterThan(0);

    await input.key(client, { keyCode: 256 });
    await screen.waitFor(client, "PauseScreen");
    await screen.clickWidget(client, { labelPattern: "Options*" });
    await screen.waitFor(client, "OptionsScreen");
    await uiSounds.waitFor({ id: "minecraft:ui.button.click" });
    const uiCapture = await uiSounds.stop();
    report.ui_capture = uiCapture;
    const clicks = uiCapture.events.filter((event) => event.id === "minecraft:ui.button.click");
    expect(clicks.length, "one press plays exactly one click").toBe(1);
    const click = clicks[0]!;
    expect(click.sample, "vanilla's only variant for this event").toBe("minecraft:random/click_stereo");
    expect(click.source).toBe("master");
    expect(click.volume).toBeCloseTo(0.25, 5);
    expect(click.relative, "a UI sound is positioned relative to the listener").toBe(true);
    expect(click.attenuation).toBe("none");
    expect(click.range, "an unattenuated sound carries no range").toBeNull();
    expect(click.subtitle).toBeNull();
    await screen.dismiss(client);

    await world.command(server, `tp @a ${NOTE_POSITION.x} ${NOTE_POSITION.y} ${NOTE_POSITION.z}`);
    await tick.sprint(server, 5);

    const worldSounds = await media.startSounds(client, { maxEvents: 128 });
    await world.command(server, PLAY_NOTE);
    await worldSounds.waitFor({ id: NOTE_EVENT });
    const worldCapture = await worldSounds.stop();
    report.world_capture = worldCapture;
    const notes = worldCapture.events.filter((event) => event.id === NOTE_EVENT);
    expect(notes.length, "the played note reached the client once").toBe(1);
    const note = notes[0]!;
    expect(note.sample, "block.note_block.harp has exactly one variant").toBe(NOTE_SAMPLE);
    expect(note.source).toBe("master");
    expect(note.subtitle).toBe(NOTE_SUBTITLE);
    expect(note.position).toEqual(NOTE_POSITION);
    expect(note.relative).toBe(false);
    expect(note.attenuation).toBe("linear");
    expect(note.range).toBeCloseTo(16, 5);
    expect(note.volume).toBeCloseTo(1, 5);
    expect(note.pitch).toBeCloseTo(1, 5);
    expect(note.elapsedMs).toBeGreaterThanOrEqual(0);
  } finally {
    await testInfo.attach("sound-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});

test("the audio muxed into a recording of an offscreen client is the client's mix, not silence", async ({ server, client }, testInfo) => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};
  const file = path.join(OUT, "live-sound-recording-offscreen.mp4");

  try {
    rmSync(file, { force: true });
    await world.command(server, "time set noon");
    await world.command(server, `tp @a ${NOTE_POSITION.x} ${NOTE_POSITION.y} ${NOTE_POSITION.z}`);
    await tick.sprint(server, 5);

    const recording = await media.record(client, { path: file, fps: 12, audio: true });
    for (let i = 0; i < 4; i++) {
      await world.command(server, PLAY_NOTE);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const result = await recording.stop();
    report.result = result;
    expect(result.audio?.muxed, `the mix was not muxed: ${result.audio?.reason ?? ""}`).toBe(true);
    expect(existsSync(file) ? statSync(file).size : 0).toBeGreaterThan(32 * 1024);

    const streams = spawnSync("ffprobe",
      ["-v", "error", "-show_entries", "stream=codec_type,codec_name,sample_rate,channels", "-of", "csv=p=0", file],
      { encoding: "utf8", timeout: 120_000 });
    report.streams = String(streams.stdout ?? "").trim();
    expect(report.streams, "the recording carries an audio stream").toMatch(/audio/);

    const levels = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8", timeout: 120_000 });
    const stderr = String(levels.stderr ?? "");
    const maxVolume = Number.parseFloat(/max_volume:\s*(-?[0-9.]+) dB/.exec(stderr)?.[1] ?? "-91");
    report.max_volume_db = maxVolume;
    expect(maxVolume, `the muxed track peaks at ${maxVolume} dB, which is silence`).toBeGreaterThan(-50);
  } finally {
    await testInfo.attach("sound-recording-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});

/** The loudest sample of a media file's audio, in dB (ffmpeg volumedetect); -91 when it has none. */
function maxVolumeDb(file: string): number {
  const levels = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf8", timeout: 120_000 });
  return Number.parseFloat(/max_volume:\s*(-?[0-9.]+) dB/.exec(String(levels.stderr ?? ""))?.[1] ?? "-91");
}

test("an audio recording of the client's mix is silent until a note plays, then holds it", async ({ server, client }, testInfo) => {
  test.setTimeout(900_000);
  const report: Record<string, unknown> = {};
  const quiet = path.join(OUT, "live-audio-quiet.wav");
  const notes = path.join(OUT, "live-audio-notes.wav");

  try {
    await world.command(server, "time set noon");
    await world.command(server, `tp @a ${NOTE_POSITION.x} ${NOTE_POSITION.y} ${NOTE_POSITION.z}`);
    await tick.sprint(server, 5);

    // Nothing plays: the mix is rendered all the same, in real time, and it is silence.
    const silent = await media.recordAudio(client, { path: quiet });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const silentResult = await silent.stop();
    report.quiet = { ...silentResult, maxVolumeDb: maxVolumeDb(quiet) };
    expect(silentResult).toMatchObject({ sampleRate: 48_000, channels: 2 });
    expect(silentResult.durationMs, "the mix is rendered in real time").toBeGreaterThan(1_200);
    expect(silentResult.durationMs).toBeLessThan(2_500);
    expect(silentResult.firstNanos).toBeDefined();

    const recording = await media.recordAudio(client, { path: notes });
    for (let i = 0; i < 3; i++) {
      await world.command(server, PLAY_NOTE);
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    const result = await recording.stop();
    const peak = maxVolumeDb(notes);
    report.notes = { ...result, maxVolumeDb: peak };
    expect(result.silenced, "no chunk was lost").toBe(0);
    expect(peak, `the recording peaks at ${peak} dB, which is silence`).toBeGreaterThan(-50);
    expect(peak, "the quiet recording is quieter than the notes").toBeGreaterThan((report.quiet as { maxVolumeDb: number }).maxVolumeDb + 20);
  } finally {
    await testInfo.attach("audio-recording-report.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  }
});
