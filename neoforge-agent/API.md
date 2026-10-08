# Blockwright agent API

Reference for code that runs inside the game: **tasks** (one-shot Java sent with `run`) and **modules** (library
Java loaded with `load`).

Task and module code may reference the game, every mod, `dev.blockwright.api` (including
`dev.blockwright.api.access`) and previously loaded modules. Every other `dev.blockwright.*` package is hidden
from javac (compile error "package ... does not exist"), both in the game and in the gradle `modules` check.

## Wire protocol (game channel)

Handshake: the driver's `game.connect` returns `{protocol:"blockwright-game", host, port, token}`. Open TCP to
`host:port`, send `{"token":"..."}\n`. The agent answers `{"type":"welcome","protocol":"blockwright-game"}\n`,
or `{"id":0,"error":{"code":"unauthorized",...}}\n` and closes. Tokens are single use and expire after 30 s.

After that, newline-delimited JSON in both directions, plus raw bytes after binary headers (agent to client only).

Client to agent (every request has a numeric `id`):

```
{"id":N,"op":"run","task":{"source":"...","thread":"server|client|worker","args":<json>,"timeoutMs":15000,
                           "limits":{"maxNodes":100000,"maxDepth":64,"maxItems":100000,"maxString":1000000}}}
{"id":N,"op":"cancel","run":R}
{"id":N,"op":"load","module":{"name":"blockwright.minecraft","sources":{"blockwright/minecraft/Input.java":"..."}}}
{"id":N,"op":"unload","module":"blockwright.minecraft"}        or  {"id":N,"op":"unload","all":true}
{"id":N,"op":"status"}
```

Agent to client:

```
{"run":R,"out":<json>}                                      one JSON output
{"run":R,"bytes":K,"meta":<json|null>}\n<K raw bytes>        one binary output
{"run":R,"end":"ok"}                                        exactly once per run, always last for R
{"run":R,"end":"error","error":{"code":..,"message":..,"detail":<json|null>}}
{"run":R,"end":"cancelled"}
{"run":R,"end":"error","error":{"code":"duplicate-run",..},"duplicate":true}   a refused run request, see below
{"id":N,"result":<json>}   {"id":N,"error":{"code":..,"message":..[,"detail":..]}}   replies to non-run ops
```

- `run`: `R` is the request id. No `id` reply: the stream is the reply. `source` is required; `thread` defaults to
  `server`; `args` defaults to `{}`; `timeoutMs` defaults to 15000, `0` means none. The deadline starts once
  compilation succeeds and covers the rest of the run (including a returned stage). `limits` bound JSON encoding
  of every output of the run (each field optional).
- End error codes produced by the agent: `compile` (detail `{diagnostics:[{file,line,column,message}]}`; the
  message lists them as `Task.java:line:col: ...` and, only when a name did not resolve, what javac could see),
  `exception` (detail `{exception: className, trace: text}`), `timeout`, `unavailable` (no server running for
  `server`; no client for `client`), `invalid` (malformed task), `limit` (too many live runs on the connection),
  `overflow` (the connection's JSON output queue is full), `duplicate-run` (see below). A `TaskException` chooses
  any other code.
- A `run` whose id a live run of the connection already uses is refused with an end keyed by that id and marked
  `"duplicate":true`: it ends the refused request only. The live run is not disturbed; its frames keep coming
  under the same id (the check and the registration are atomic, so two runs never share an id). The wire cannot
  tell the two apart otherwise, so a client must never reuse an id that may still be live; the TS client never
  reuses ids, so for it the marked end ends the run it knows under that id and later frames for the id are
  dropped.
- `cancel` → `{"cancelled":true}` if the run was live (it then ends `cancelled`), else `false`.
- `load` → `{"name","version","classes":[...],"replaced":bool,"cached":bool,"compileMs","relinked":[names],
  "unusable":{name: reason}}`; a compile failure is an error reply with code `compile` and the same
  `detail.diagnostics`. `relinked`/`unusable`: see Modules.
- `unload` → `{"unloaded":[names]}`.
- `status` → `{"protocol","server":bool,"client":bool,"compiler":{"available","cachedTasks"},
  "modules":[{"name","version","files","classes","compileMs","ageMs","compiledAgainst":["name@version"],"stale"
  [,"unusable": reason]}],
  "runs":[{"run","thread","state","ageMs","droppedBinary"}] (this connection), "liveRuns" (all connections),
  "queuedBinaryBytes","limits":{"maxRunsPerConnection","maxQueuedBinaryBytes","maxQueuedJsonBytes"}}`.
- Other errors: `unknown-op`, `invalid` (bad request fields; `id` is null for an unparseable line).
- Ordering: `load`, `unload` and run compilation are processed in request order on one compile thread, so a
  pipelined `load` then `run` compiles the run against the module. A run whose task is already compiled against
  the current modules (a cache hit) skips that queue when nothing it must follow is queued — no `load`/`unload`
  from any connection, no earlier run compile of its own connection — so it does not wait behind another
  connection's compile, and a connection's runs are still dispatched in request order. Replies and streams
  otherwise interleave freely.
- Runs are concurrent; nothing is serialised except by the thread a task chose.
- Closing the connection (or the driver revoking it) cancels every live run of the connection and closes their scopes.
- Caps per connection: 64 live runs; 64 MiB of queued binary output; 64 MiB of queued JSON output.

## Task shape

```java
import dev.blockwright.api.*;

public final class Task {
    public static Object run(Context ctx) throws Exception { ... }
}
```

One compilation unit, default package, top-level class `Task` with a static `run(Context)`; other top-level or
nested classes in the same source are fine. Return value:

| `run` returns / throws | Outputs | End |
|---|---|---|
| non-null value (not a `CompletionStage`) | the value | `ok` |
| `null` | none | `ok` |
| `CompletionStage` completing with a value | the value if non-null | `ok` |
| stage completing exceptionally | | `error` `exception` (or the `TaskException` code) |
| stage cancelled / `CancellationException` | | `cancelled` |
| throws | | `error` `exception` (or the `TaskException` code) |

After a cancel, deadline or disconnect the run's returned stage is cancelled (`toCompletableFuture().cancel`), a
`worker` thread still inside `run` is interrupted, and late results are dropped.

## Context

| Method | Notes |
|---|---|
| `long runId()` | the run id |
| `String thread()` | `server`, `client` or `worker` |
| `Object args()` | JSON args as `Map<String,Object>` (ordered) / `List<Object>` / `String` / `Boolean` / `Long` (integral) / `Double` / null; `{}` when absent |
| `Object arg(String)` | `args().get(name)` when args is an object |
| `MinecraftServer server()` | dedicated or integrated server, else null |
| `Object client()` | `net.minecraft.client.Minecraft` on clients, null on dedicated servers; cast in client-only code |
| `void emit(Object)` | one JSON output, encoded immediately on the calling thread (see encoding) |
| `boolean emitBytes(byte[], Object meta, DropPolicy)` | one binary output; `false` if dropped; the array is not copied |
| `boolean emitBytes(byte[], Object meta)` | `DropPolicy.BLOCK` |
| `long droppedBinary()` | chunks of this run dropped so far |
| `void onClose(AutoCloseable)` | closed exactly once when the run ends (reverse order); immediately if already ended |
| `boolean isCancelled()` | true once the run is ending for any reason |
| `CompletableFuture<T> onServer(Callable<T>)` | server thread (inline if already on it) |
| `CompletableFuture<T> onClient(Callable<T>)` | client thread (inline if already on it) |
| `CompletableFuture<T> onWorker(Callable<T>)` | pool thread |
| `Registration subscribe(Hook<E>, Consumer<? super E>)` | released with the scope; a throwing listener ends the run with `exception` |
| `Registration claim(Slot<T>, T)` | override slot claim, released with the scope |

Scope: the run ends exactly once (return, stage completion, throw, cancel, deadline, disconnect, listener
failure, JSON overflow). Close actions run on the thread that ended the run and may still emit (their outputs
precede the end message); after that, emits are dropped. Hops fail with `TaskException("unavailable")` when the
thread does not exist and with `CancellationException` (without running) when the run has ended first — except
a hop requested by a close action, which is cleanup and always runs (possibly after the end message was sent). A
close action that must touch the game from another thread (restore a screen, a setting) therefore hops:
`ctx.onClose(() -> ctx.onClient(() -> { mc.setScreen(null); return null; }))`.

Encoding (`emit`, `meta`, `TaskException.detail`): null, booleans, numbers (non-finite as strings), strings,
chars, enums (name), `Optional`, maps (keys via `String.valueOf`), iterables, arrays, records (by component) and
Gson `JsonElement`s; anything else → `{"$class":..,"$string":..}`. Limits add markers: `{"$truncated":true}`
(node budget or depth), `{"$more":n}` in arrays / `"$more":n` in objects (maxItems), strings clipped with
`…(+n)`, `"$cycle":true`, `"$error"` for a throwing read.

`DropPolicy` (binary queue full): `BLOCK` waits for room (returns false if the run or connection ends first;
never use it on the render/server thread unless stalling the game is intended); `DROP_OLDEST` drops this run's
oldest queued chunks to make room; `DROP_NEWEST` drops this chunk.

`TaskException(code, message, detail)` (RuntimeException): throw it, or complete the returned stage with it, to
end `error` with that code.

## Hooks and slots

`Hook<E>`: `subscribe(Consumer)` / `subscribe(Consumer, Consumer<Throwable> onFailure)` → `Registration`,
`publish(E)`, `active()`, `name()`. Listeners run synchronously on the publishing thread in subscription order;
exceptions never reach the game (without `onFailure` they are logged once per subscription). Modules may create
their own hooks. `Slot<T>`: `claim(T)` → `Registration`, `get()`; the newest open claim wins, closing restores the
previous one. Prefer `ctx.subscribe` / `ctx.claim` so registrations die with the run.

All in `dev.blockwright.api.Hooks`. Client hooks exist everywhere but only fire on clients.

| Hook / slot | Thread | Payload |
|---|---|---|
| `SERVER_TICK_START` | server | `MinecraftServer` (`ServerTickEvent.Pre`) |
| `SERVER_TICK_END` | server | `MinecraftServer` (`ServerTickEvent.Post`) |
| `CLIENT_TICK_START` | client | `Object` = `Minecraft` (`ClientTickEvent.Pre`) |
| `CLIENT_TICK_END` | client | `Object` = `Minecraft` (`ClientTickEvent.Post`) |
| `FRAME_RENDERED` | render | `Frame(index, width, height, guiWidth, guiHeight, colorTextureId, framebufferId, Object renderTarget, nanoTime)` — after the game rendered into the main target, before swap; GL context current, restore any GL state you touch |
| `GUI_DRAW` | render | `GuiDraw(kind TEXT/ITEM/RECT, text, ItemStack item, x, y, width, height, int argb color, Integer colorBottom)` — GUI-scaled pixels after the pose; colours are the ARGB ints the game drew with; TEXT from `Font.drawInternal` outside the world pass, ITEM from `GuiGraphics.renderItem` (16×16 scaled), RECT from `fill`/`fillGradient` (gradient bottom in `colorBottom`) |
| `WORLD_DRAW` | render | `WorldDraw(kind TEXT/ITEM/NAME_TAG/LINE_BOX/FILLED_BOX, text, ItemStack item, Entity entity, minX..maxZ, int argb color, float red, green, blue, alpha)` — world coordinates; `color` is TEXT's ARGB colour, `red`..`alpha` a box's channels (0..1) exactly as the game passed them (0 where they do not apply); points have min==max; TEXT = font calls inside `LevelRenderer.renderLevel`; ITEM = `ItemRenderer.renderStatic` in the world pass; NAME_TAG = `EntityRenderer.renderNameTag` (its own font calls are not also published); LINE_BOX = `renderLineBox` and each box of `renderShape`; FILLED_BOX = `addChainedFilledBoxVertices` |
| `RENDER_BATCH` | render | `RenderBatch(Object renderType, String name, int vertices, boolean worldPass)` from `RenderType.draw` |
| `SOUND_PLAYED` | client (usually) | `SoundPlayed(Object instance, Object events, id, sample, source, subtitle, volume, pitch, x, y, z, looping, relative, attenuation, range)` from the sound manager's listener; unresolved sounds are skipped |
| `AUDIO_MIXED` | agent audio thread | `AudioBlock(position, frames, sampleRate, channels, float[] samples, nanoTime)` — 10 ms of the client's mix (48 kHz float stereo, interleaved; do not modify `samples`), rendered in real time from the OpenAL loopback device the sound engine plays into; blocks are contiguous by `position`, and `nanoTime` (when the first sample is due) is on the clock of `Frame.nanoTime` |
| `CAMERA` (slot) | render | `CameraOverride` (`CameraPose pose(float partialTick)`, null = no override) applied at the end of `Camera.setup`; a pose sets position and/or rotation, and the override's `Boolean detached()` (default `true`; `false` attaches, null keeps the game's) sets detachment on posed frames. `CameraOverride.of(detached, poses)`, `CameraPose.of/position/rotation` |
| `HURT_SHAKE` (slot) | render | `Boolean`; `false` skips the hurt camera shake (`GameRenderer.bobHurt`) |
| `TOASTS` (slot) | render | `Boolean`; `false` stops toasts from being drawn (`ToastComponent.render`) |
| `TERRAIN_FOG` (slot) | render | `FogOverride` (`FogRange fog(float farPlane)`, null = the game's) applied at the end of `FogRenderer.setupFog` for terrain fog (not thick fog); `FogRange(start, end)` in blocks |
| `KEY_DOWN` (slot) | client | `IntPredicate` over GLFW key codes; accepted keys read as held in `InputConstants.isKeyDown` (e.g. for `Screen.hasShiftDown`) |

Payloads typed `Object` are client classes; keep code that names client classes in client-only classes so
dedicated servers never load them. Do not keep or mutate `ItemStack`s from draw events.

Accessor mixins for modules, in `dev.blockwright.api.access` (method names prefixed `blockwright$`):
`CameraAccessor` (setPosition, setRotation, setDetached), `ChatComponentAccessor` (allMessages),
`ClientPacketListenerAccessor` (levelLoadStatusManager), `GuiAccessor` (overlayMessage, overlayMessageTime,
title, subtitle, titleTime), `KeyboardHandlerAccessor` (charTyped), `MouseHandlerAccessor` (onPress, onScroll,
setXpos, setYpos, setAccumulatedDX/DY, activeButton, mousePressedTime), `MultiPlayerGameModeAccessor`
(ensureHasSentCarriedItem), `ServerConnectionListenerAccessor` (channels), `SoundEngineAccessor` (loaded),
`SoundManagerAccessor` (soundEngine). Use: `((CameraAccessor) camera).blockwright$setRotation(yaw, pitch)`.
Adding an accessor means changing the agent (mixins cannot be added at run time).

## Epoch

`dev.blockwright.api.Epoch`, a server-to-client ordering primitive with no policy:

| Method | Side | Meaning |
|---|---|---|
| `String serverId()` | server | random id of this process's server |
| `long advance()` | server, any thread | increments; the new value is sent to every client with the payload at the end of the next server tick |
| `long current()` | server | current epoch (0 before any advance) |
| `String receivedServerId()` | client | server this client last heard from, or null |
| `long received()` | client | highest epoch received from that server, -1 if none |
| `CompletableFuture<Long> barrier()` | client | round trip through the server; completes with the server epoch after everything the server sent before answering; -1 at once if the server lacks the payload, -1 on disconnect |
| `CompletableFuture<Long> awaitReceived(serverId, epoch)` | client | completes once `received() >= epoch` for that server; -1 at once if connected elsewhere/nowhere, -1 on disconnect or server change |

Futures complete on the thread handling the payload (hop with `ctx.onClient` before touching the game) and never
time out on their own (`orTimeout`). Prefabs decide which operations advance and when clients wait (e.g. a
mutating task returns `Epoch.advance()` and `Epoch.serverId()`; a client task then `awaitReceived`s them).

## Modules

- `sources` maps relative paths ending in `.java` to source text; every file declares a package; packages under
  `java.*` and `dev.blockwright.*` are refused. Several files and packages per module are fine. Name:
  `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`.
- A module is compiled against the modules loaded before it — every loaded module for a new one; for a reload, those
  before its place in the load order, which it keeps — and gets its own class loader: own classes, then those
  modules (newest first), then the agent, then the game.
- Cache key: SHA-256 of the sorted sources plus `name@version` of every module compiled against; the key is the
  module's `version`. Loading identical sources against the same set is a no-op (`cached:true`).
- Loading a name again replaces it for later compiles and recompiles every module loaded after it (they were
  compiled against it), in load order, from their kept sources, against the new copies (`relinked` in the reply),
  so a later task never sees the new module beside a dependent still linked to the old one. A dependent that no
  longer compiles is marked unusable (`unusable` in the reply and in `status`): it stays listed but is hidden from
  later compiles, and a compile error over a name that did not resolve says why; loading it again (fixed) makes it
  usable. Running tasks keep the copies they were linked against. Ensuring a relinked module again with the same
  sources is a `cached` no-op.
- `unload` removes a module for later compiles only (modules compiled against it are not recompiled; `status` marks
  them `stale`); `unload all` also clears the compile caches.
- Tasks are compiled against all loaded modules; a task's cache key likewise includes their versions.

Repository layout: prefab modules live under `packages/<pkg>/java/**` (package directories below `java/`). The
gradle `modules` source set compiles all of them together against the game classpath plus a jar of
`dev.blockwright.api` only, on `check`/`build`, and is never bundled. Because they compile as one source set,
keep default-package `Task` templates out of `java/` (they would clash). `packages/blockwright-minecraft/java/
blockwright/minecraft/core/` (waits over ticks, reflection, JSON readers, sync marks) is the example; see
`packages/blockwright-minecraft/PREFAB.md`.

## Porting reference

The previous semantic RPC implementation (`git show 86b9a68` has it whole) has been ported into the prefab
modules of `packages/blockwright-minecraft`, except what was dropped by design (the resizable preview frame
stream, the old status details); see the end of `packages/blockwright-minecraft/PREFAB.md`.
