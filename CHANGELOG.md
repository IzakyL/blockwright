# Changelog

## 0.1.0-alpha.1 — 2026-10-13

- New package `@izakyl/blockwright-cinema`: smooth keyframed camera paths and orbits,
  world speed curves, and frame-stepped timelapse capture. Each run shoots several
  cameras from the same ticks, with optional motion blur, preview runs, cues at given
  ticks and an MP4 per camera. Also: walks and follow cameras as paths (`walkPath`,
  `followPath`, `standPath`, `cutTo`); further clients as cameras on one server
  (`launchCameras`, `standCamera`, `moveCamera`); `clearestView`, which picks the eye
  that sees most of a subject through the blocks standing now; `stillWorld` and
  `walkSpeed`; and Iris shader packs seeded into a client and confirmed from its log
  (`seedShaderPack`, `shaderEvidence`).
- `@izakyl/blockwright-client`: `seedInstance` fills an instance dir (configs, a world,
  packs) before its game launches and gives the launch options that keep it;
  `instanceDirOf` names the dir.
- `@izakyl/blockwright-minecraft`:
  - Calls that answer instead of throwing, for outcomes a test records and judges
    later: `attempt` (with `isRefusal`), `world.tryCommand`, `world.tryWaitFor`,
    `screen.tryWaitFor` (any screen without a class name).
  - `tick.sample` sprints in steps and reads the world after each; `tick.meter` keeps
    every tick's duration in the game and dumps it as CSV.
  - `camera.fov` holds the field of view without detaching the camera; `camera.hud`
    hides or shows the GUI alone. `camera.reset` releases both.
  - `world.keepSave` copies the running server's world, flushed and with saving off.
  - `reflect.dump` walks a whole object; `media.probeVideo` reads a recording's
    duration and how much of it is black.

## 0.1.0-alpha.0 — 2026-10-09

- Initial Linux x64 release: native driver, Minecraft automation, UI adapters,
  Playwright fixtures and MCP stdio server.
- Servers launch only after the Minecraft EULA is accepted explicitly with
  `neoforge.server.eula = true`, and test servers bind to loopback by default.
