// `media`: screenshots, video and audio recording, draw-call and sound capture.
export { screenshot, type ScreenshotOptions, type ScreenshotResult, type ScreenshotTerrain } from "../media/screenshot.js";
export {
  startRecording as record,
  type FrameDropPolicy,
  type FrameRecording as Recording,
  type RecordingAudio,
  type RecordingOptions,
  type RecordingResult,
} from "../media/recording.js";
export {
  startAudioRecording as recordAudio,
  type AudioRecording,
  type AudioRecordingOptions,
  type AudioRecordingResult,
} from "../media/audio.js";
export {
  captureDraws as draws,
  startDrawCapture as startDraws,
  drawEntriesOf as drawEntries,
  type CaptureDrawsOptions as DrawsOptions,
  type DrawCaptureOptions,
  type DrawCapture,
  type DrawCaptureResult,
  type DrawChannel,
  type DrawEntry,
  type DrawEntryKind,
  type DrawRgba,
  type DrawFrame,
  type DrawBatch,
} from "../media/draw.js";
export {
  startSoundCapture as startSounds,
  waitForSounds,
  type SoundCapture,
  type SoundCaptureOptions,
  type SoundCaptureResult,
  type SoundCaptureStatus,
  type SoundEngineState,
  type SoundEvent,
  type SoundWaitFilter,
  type WaitForSoundsOptions,
  type WaitForSoundsResult,
} from "../media/sound.js";
export { encodePng, decodePng, distinctColors, type RgbaImage } from "../media/png.js";
