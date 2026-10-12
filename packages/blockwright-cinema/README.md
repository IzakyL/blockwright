# @izakyl/blockwright-cinema

Camera paths, time curves and frame-stepped timelapse capture on top of
`@izakyl/blockwright-minecraft`.

```sh
npm install @izakyl/blockwright-cinema @izakyl/blockwright-minecraft
```

Linux x64 only, Node >=22.14, ESM. Encoding the finished frames needs `ffmpeg` on
PATH. Minecraft 1.21.1 / NeoForge 21.1.233 is the supported game pair.

## How it works

A timelapse is shot frame by frame. With the world frozen, each frame runs the world up
to its tick, sets every camera to its pose for that moment, and takes a screenshot. Since
every frame is taken at a known tick from a known pose, the video plays at an exact speed
however slow the shots are, and a frame the game was slow to render is never dropped.

- **Camera paths** (`cameraPath`) go through keyframes on a smooth curve whose speed
  carries across each keyframe. A keyframe is set by a yaw and pitch, or by a `target`
  to look at. `ease` shapes each segment. `orbit` writes the keyframes for a circle.
- **Time curves** (`speed`) give the world's speed as a multiple of real time, once or
  per keyed moment, changing evenly in between: 1x at the start, 200x through the
  build, back to 1x for the finished result.
- **Several cameras** are shot on every frame from the same world tick, so one run
  gives every angle of the same take.
- **Motion blur** (`blur.samples`) shoots several samples over the shutter and
  averages them. The world and the camera both move between the samples.
- **Preview** (`preview: true`) shoots every 4th frame at 640 pixels wide over the
  same ticks, so a framing can be checked before the full run.
- **Cues** do things to the world at given ticks, such as placing a blueprint at 0 and
  a road at 2000.

Around the shooting:

- **Walks** (`walkPath`) go through points on the ground at an even pace, and
  `followPath` is the camera that keeps such a walker in frame from behind.
  `standPath` holds a pose; `cutTo` plays one path, then another.
- **Further cameras** (`launchCameras`) are more clients joined to the same server,
  each a player of its own, for recording one real-time run from several places.
  `standCamera` makes a client a camera (spectator, GUI hidden, free camera at the
  pose); `moveCamera` sends it on.
- **`clearestView`** casts sight lines in the game and picks, of several eyes, the
  one that sees most of a subject: a pose worked out on paper can be behind a roof.
- **`stillWorld`** stops the sun, the weather and mob spawning; `walkSpeed` sets a
  player's pace in blocks per second.
- **Shader packs** (`seedShaderPack`) are unpacked into a client's instance dir
  before launch, with settings and source patches, for clients with Iris among
  their mods; `shaderEvidence` confirms from the log that the pack compiled, since
  one that does not falls back to vanilla without stopping the game. Needs `unzip`.

## Example

```ts
import { cameraPath, orbit, timelapse } from '@izakyl/blockwright-cinema';

const site = { x: -169, y: 70, z: 218 };
await timelapse(server, client, {
  out: 'out/timelapse',
  seconds: 20,
  fps: 30,
  speed: [{ at: 0, speed: 1 }, { at: 2, speed: 200 }, { at: 18, speed: 200 }, { at: 20, speed: 1 }],
  cameras: {
    wide: { position: { x: -200, y: 95, z: 180 }, yaw: -40, pitch: 30, fov: 70 },
    orbit: cameraPath(orbit({ center: site, radius: 40, height: 25, fromYaw: -30, toYaw: 60, start: 0, end: 20 })),
  },
  blur: { samples: 3 },
  cues: [{ tick: 0, run: () => world.command(server, 'say the build begins') }],
});
```

The result lists each camera's frame directory and MP4. `timelapse.json` records every
frame's ticks and poses, so captions and cuts can be timed to the world.

The client does not sprint, so each advance ends with `catchUpTicks` (default 3) at the
game's own pace. Without them, entities the client moves by interpolation would be
caught mid-step.

Any additional packages imported by the example must also be installed explicitly.
Game examples require a `blockwright.toml` with explicit EULA acceptance.
See [setup and configuration](https://github.com/IzakyL/blockwright#quick-start).

MIT licensed; see LICENSE.
