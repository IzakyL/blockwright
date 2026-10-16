# @izakyl/blockwright-minecraft: prefab conventions

This package is the Minecraft prefab: Java modules it ships into the game, task templates
that call them, typed TS wrappers, and the policies (sync, waiting) that turn the neutral task runtime
(`neoforge-agent/API.md`) into Minecraft semantics. Read that document first.

The core (`src/core/`, `java/blockwright/minecraft/core/`) is shared: everything two areas need lives there,
once. The areas build on it, each in its own directories.

## Layout

| Area | TS | Java module(s) | Live spec |
|---|---|---|---|
| core | `src/core/` | `blockwright.minecraft.core` (both sides), `blockwright.minecraft.core.client` (clients) | `live/minecraft-core.spec.ts` |
| world | `src/world/` | `blockwright.minecraft.world` | `live/minecraft-world.spec.ts` |
| client | `src/client/` | `blockwright.minecraft.client` | `live/minecraft-client.spec.ts` |
| media | `src/media/` | `blockwright.minecraft.media` | `live/minecraft-media.spec.ts` |
| ui | `src/ui/` (the `@izakyl/blockwright-ui` platform and vanilla adapter) | none (uses `client`) | `live/minecraft-ui.spec.ts` |
| evidence | `src/evidence/` (failure evidence, crash summaries, game logs, observation) | none (uses `world`, `client`, `media`) | `live/test-fixtures.spec.ts` |

- The public API is namespaces: `src/api/<namespace>.ts` lists, by name, what each namespace exports
  (`world`, `tick`, `player`, `input`, `screen`, `chat`, `camera`, `media`, `reflect`, `evidence`, `ui`), and
  `src/index.ts` exports them (`export * as world from …`) next to the root names: handles, task authoring,
  errors, the JSON shapes and `launchGame`. Nothing reaches the public API that is not listed there.
- A namespace is what the caller thinks about, not where the code lives: `player` draws on the client area and a
  core server step (`player.aim`), `world.block` reads the server's world or a client's own level.
- Inside the package, implementation names stay unique and prefixed (`worldBlock`, `stateScreen`, …); the
  namespace files rename them (`worldBlock as block`).
- A helper two areas need belongs in core, not copied into both. What code building on the prefab (UI adapters,
  front ends, other prefabs) needs beyond the public API — template factories, long runs, wait budgets, UI glue,
  log helpers — is exported from `src/internal.ts` (`@izakyl/blockwright-minecraft/internal`).
- The package depends on `@izakyl/blockwright-ui`: `src/ui/` implements its platform and the vanilla adapter on the
  client area's input and screen functions.
- Evidence has no Java of its own: what it reads in the game goes through the areas' public functions (the
  player and the containers around it are `world.nearPlayer`, `WorldQueries.nearPlayer`).
  How processes ended comes from the driver: the trace's `process.died`/`process.exit` events
  (`evidence.readCrash`) or a close answer (`evidence.closeCrash(await instance.close())`).
- `launchGame` (`src/launch.ts`) is the launch path both front ends use: the client's `launchPair` with the
  crash-aware retry policy, evidence of every failed attempt, and a graceful server stop before close.

## Modules

A module is **one Java package directory** under `java/`, non-recursive; the module name is the package name.
Nested packages are separate modules — that is how client-only code is kept away from dedicated servers,
which cannot compile client classes (`net.minecraft.client.*`, `com.mojang.blaze3d.*`). Code in a module
loaded on servers must not name client classes anywhere (not even in a method a server never calls).

Declare your area's module(s) in `src/<area>/module.ts`:

```ts
import { CORE, CORE_CLIENT, defineModule } from "../core/index.js";
import { moduleTasks } from "../core/templates.js";

export const WORLD = defineModule("blockwright.minecraft.world", { requires: [CORE] });
export const worldTask = moduleTasks(WORLD);
export const CLIENT = defineModule("blockwright.minecraft.client", { requires: [CORE_CLIENT], roles: ["client"] });
export const clientTask = moduleTasks(CLIENT);
```

- `requires` lists modules the Java references (core only; no area-to-area dependencies). A client-only module
  requires `CORE_CLIENT` (which requires `CORE`).
- `roles` defaults to both; client-only modules must say `["client"]` (loading one on a server throws in TS).
- Split an area into more packages (`blockwright.minecraft.world.tick`, …) when it grows; each is a module.
- Loading is automatic: a handle's `run`/`start` ensures the side's core modules plus the template's
  `modules` (and what they require), in dependency order, **once per game connection** (the client's
  `instance.ensureModules`; after a reconnect they are sent again and the agent answers `cached`). Changing a
  module's sources reloads it; the agent recompiles everything loaded after it against the new copy at once, and
  the connection's ledger sends those again when next ensured (answered `cached`, or a real load that repairs one
  the agent marked unusable). `mc.server.ensure(MOD)` loads eagerly.
- Gradle compile-checks every file under `packages/*/java/**` against the game plus `dev.blockwright.api`:
  `cd neoforge-agent && gradle compileModulesJava` (part of `gradle build`). Run it before any live test.
  All prefab Java compiles as **one** source set: packages must be unique, and default-package `Task`
  classes must never live under `java/`.
- Java 21; `dev.blockwright.api` and `blockwright.minecraft.core.*` are what you build on. Module statics
  live as long as that loaded copy of the module (a reload starts fresh) and are shared by all connections.
  State that must outlive a run and survive area reloads (held camera and clean-view claims, the long-run
  registry) therefore lives in core, which is loaded first and not reloaded when an area changes.

## Task templates

A template is Java source plus metadata. Logic goes into module classes (gradle-checked); a template is one
call into them (templates are compiled in the game only, so keep them trivial). There is one way to declare
one: the area's factory from `moduleTasks(MODULE)` (`src/core/templates.ts`), as a module-level constant.

```ts
// src/world/queries.ts
import type { BlockAtJson, MinecraftServer } from "../core/index.js";
import { defined } from "../core/templates.js";
import { worldTask } from "./module.js";

const BLOCK = worldTask<{ pos: WorldPos; dimension?: string; nbt?: boolean }, BlockAtJson>("world.block", "WorldQueries.block");

export function worldBlock(server: MinecraftServer, pos: WorldPos, options: WorldBlockOptions = {}) {
  const { signal, timeoutMs, ...args } = options;
  return server.run(BLOCK, { pos, ...defined(args) }, defined({ signal, timeoutMs }));
}
```

and lists it in `src/api/world.ts` as `worldBlock as block`.

- `factory(name, call, options?)`: `call` is an entry point `Class.method` of the module, called as
  `return Class.method(ctx, Args.of(ctx));`, or a complete `run` body
  (`"return ClientState.hudText(ClientGame.mc(ctx));"`). The source imports the standard set
  (`dev.blockwright.api.*`, `blockwright.minecraft.core.*`, `java.util.*`, `java.util.concurrent.*`), the module's
  package, and on the client side `blockwright.minecraft.core.client.*`.
- The side is `client` for a client-only module, else `server`; `options` may set `side` (`any` runs on
  either, on the instance's own thread), `thread`, `parse`, `timeoutMs`, `limits`, `settle` (client),
  `requiresOutput`, and `imports`, `members`, `modules` (beyond the bound one).
- Core's own: `coreTask` (the core module; e.g. the client area's one server step, `player.aim`) and `coreClientTask`.
- Only a template whose Java comes from the caller (a wait check, a UI probe set) is built with
  `defineTask({..., source: javaTask({imports, body, members})})` directly.
- Entry points take `(Context ctx, Args args)` and answer JSON-ready values (`Values.obj(k, v, …)`), a
  `CompletionStage` of one, or throw `Fail.*`.
- The answer is the task's **last JSON output**, after `$progress` outputs are routed to `onProgress` and a
  sync stamp is removed. A run that ends ok without output throws (`no-output`) unless `requiresOutput: false`.
- `handle.run(template, args, {signal, timeoutMs, onProgress})` → parsed answer.
  `handle.start(template, args)` → the raw `Run` (after module loading and settling) for streaming tasks
  (binary frames, record streams); the caller consumes it (and must, for binary backpressure).
- Args: keep them minimal with `defined({...})` (drops undefined). A template that waits in the game takes
  `waitBudget(timeoutMs, signal)` → `{wait, run}`: `wait` goes in the args (`{wait: {timeoutMs}}`, read by
  `Wait.Options.of`), `run` is the run options with the deadline 5 s above it (`deadlineAbove(ms)`), so the
  in-game timeout reports first.
- Public API = functions taking a handle (`MinecraftServer` / `MinecraftClient`) first and an options object
  last that extends `CallOptions` (`signal`, `timeoutMs`; for a wait, `timeoutMs` is its in-game budget), plus
  their option/result types, listed in a namespace file. Points are `{x, y}` objects. Results are plain typed
  shapes (no envelope). Handles come from `launchGame`, `minecraft(pair)`, `minecraft.server(instance)`,
  `minecraft.client(instance)` (cached per instance). Core features are handle members: `run`, `start`,
  `ensure`, `waitUntil`, and `settle` on clients. `handle.instance` is the `GameInstance` (`instanceId`, `role`,
  `run`, `ensureModules`, `audio?`, `instanceDir`, `tracePath`).
- Arguments in Java: `Args.of(ctx)` gives checked reads (`string`, `integer`, `number`, `flag`, `object`,
  `list`, `strings`, `stringMap`, `blockPos`, `vec3`, `xyz`), each failing with `invalid` and naming the argument.

## Errors

Java ends runs with the codes in `Fail.java`: `invalid` (bad arguments), `not-found` (no such entity, handle,
class, member, dimension), `unavailable` (no server/client/level/player), `wait-timeout` (detail `{clock,
reason: "timeoutMs"|"maxTicks", ticks, elapsedMs, last}`), `settle-timeout` (detail `{stage}`), `reflect` (a
reflective call's target threw; detail `{exception, trace}`), `hover-mismatch` (a pointer action's hover check
found something else under the cursor; nothing was sent). Use `Fail.invalid(..)`,
`Fail.notFound(..)`, `Fail.unavailable(..)` or `new TaskException(code, message, detail)`; add a new code only
when a caller must tell it apart, in `Fail.java` and the list in `src/core/errors.ts`.

TS: `run` maps a run error to `MinecraftTaskError` (`task`, `instanceId`, `role`, `code`, `detail`,
`outputs`, `cause`), `MinecraftCompileError` (`diagnostics`) or `MinecraftTimeoutError` (`wait-timeout`,
`settle-timeout`, `timeout`; `reason` (`"timeoutMs"`/`"maxTicks"`), `clock`, `last`, `ticks`, `elapsedMs`, `stage`). `isMinecraftError(e, ...codes)` tests.
Lost instances / connections are not wrapped: they stay the client's `BlockwrightInstanceGoneError` /
`BlockwrightConnectionClosedError`. Do not return `{status: "error"}` objects; throw.

## Waiting (in the game, not by polling)

Conditions over time are decided inside the game, in one run: `Wait.until(ctx, clock, options, check)`
(Java) or `handle.waitUntil({...})` (TS, the check is Java source).

- Clocks: `SERVER_TICK` (server thread, each server tick end — **it ticks while the server is frozen**, the
  world just does not advance), `WORLD_TICK` (checked at the same moments, but `ticks`, `maxTicks` and
  `progressEvery` count world ticks: overworld game time since the wait began, `Wait.worldTime(server)`; a frozen
  world spends none), `CLIENT_TICK` (client thread), `FRAME` (after each rendered frame, client thread). TS names:
  `server`, `world`, `client`, `frame`. Servers start frozen by default (`startFrozen`); unfreezing/sprinting is
  the world area's API (`world.waitFor` is a `WORLD_TICK` wait that sprints by default), and waits must work either way.
- A check answers `null`/`false` (not yet), `Wait.pending(observed)` (not yet; `observed` shows up in
  progress and in the timeout error's `last`) or the result.
- Options: `timeoutMs` (default 10000 from TS), `maxTicks`, `progressEvery` (emits `{"$progress": …}`),
  `immediate` (check once at once when already on the clock's thread; default true).
- Area helpers that wait (`screen.waitFor`, `media.waitForSounds`, `world.waitFor`, `screen.waitForWidget`, …) are a
  `Wait.until` inside their own template, answering what the condition saw — never a TS loop of short runs. Every
  wait throws `MinecraftTimeoutError` when out of budget; none answers a "not matched" value.
  Java callers can compose: `return Wait.until(...).thenApply(r -> ...)`. Other shorthands:
  `Wait.ticks(ctx, clock, n)`, `Ticks.after(ctx, n)`, `Ticks.until(ctx, predicate)`, and
  `Wait.untilStill(ctx, clock, options, stable, read, key)` — settle until still: answers the reading once
  `key(reading)` stayed equal for `stable` further checks (an animated scroll that stopped moving).
- Keep the task's `timeoutMs` above the wait's own budget (`waitUntil` adds 5 s) so the wait reports first.

## Client/server sync policy

- **Server mutations stamp.** A server task that changes anything a client may observe (commands, block
  sets, reflective writes/calls, time/tick changes, teleports, inventory) returns `Sync.stamp(value)`
  (`{"value", "$sync": {serverId, epoch}}`; `Epoch.advance()` underneath). `run` records the mark in the
  process-wide `SyncLedger` and returns `value`. Reads do not stamp. `reflect.invoke`/`reflect.setField` stamp on servers.
- **Client tasks settle first.** Before a client template runs, if marks are pending for that client, the
  client runs `Settle` once: every pending mark received (`Epoch.awaitReceived`), then one rendered frame,
  then (if the template says `settle: { requireNoScreen: true }`) no screen open — so a client read sees the
  server's change, and player actions are not swallowed by a screen. Use `settle: false` for tasks that must
  not wait (settle itself, frame capture in progress, raw input racing the server).
- **Explicit:** `mc.client.settle({barrier?, frames?, requireNoScreen?, timeoutMs?})` (defaults: barrier on,
  requireNoScreen on, 5 s). Frame-only waits: `waitUntil({clock: "frame", …})`.
- **Client actions finish** through `Settle` (Java, `core.client`): `Settle.afterTick(ctx, value)` for input the
  game acts on in its next tick (keybinds, mouse buttons), `Settle.afterServer(value)` for actions whose packets
  the server must have handled before the caller looks (a barrier round trip; `settle-timeout` stage `barrier`
  after 5 s; adds `server: {epoch, elapsedMs}`), `Settle.afterTickAndServer` for both.

## Long-lived runs

Recordings, draw and sound captures collect until asked to stop. Java: `LongRuns.register(ctx, kind, id)`
(an `Entry` whose `stopped()` completes on a stop), `LongRuns.started(ctx, info)` once listening, then the run
drains and answers its summary. TS (`src/core/long-run.ts`): `handle.start(template, {id: longRunId(kind), …})`,
then `new LongRun(handle, template.name, kind, id, run, onBytes?)`: `started` resolves with the info, `stop()`
signals (`LongRuns.stop`), waits up to `STOP_GRACE_MS` for the summary and cancels otherwise; `cancel()` ends it
without one. Works on either side (it is core).

## The client's view

`View` (`core.client`) is the one place that claims `Hooks.CAMERA` and the render slots (`Hooks.HURT_SHAKE`,
`Hooks.TOASTS`, `Hooks.TERRAIN_FOG`) and changes the view settings that go with them (GUI, bobbing, clouds, fov).
It decides what "clean" means: no hurt shake, no toasts, terrain fog from 50 % to 70 % of the render distance,
bobbing and clouds off (and the GUI hidden when asked). Posed cameras render detached (the `CameraOverride`
default; `CameraOverride.of(false, …)` keeps it attached). Each change is a `Registration` that restores on close:
`View.camera(override)`, `View.clean(mc, hideGui)`, `View.hideGui(mc)`, `View.fov(mc, fov)`. Use them for a run
(`View.forRun(ctx, registration)`: a screenshot's posed camera) or held across runs (`holdCamera`/`releaseCamera`,
`holdFov`/`releaseFov`, `setClean`/`isClean`: the client area's free camera). Claims stack (newest wins), so a
screenshot over a held free camera leaves it as it was. Keys that must read as held while an event is
dispatched (shift-click) go through `HeldKeys.holding(modifiers, keys, dispatch)` (`Hooks.KEY_DOWN`).

## Core API reference

Java (`blockwright.minecraft.core`): `Args`, `Fail`, `Values` (object→JSON walker with limits and markers;
`truncated()` tells whether it cut anything; `Values.obj(k, v, …)` builds ordered maps), `NbtPath`, `GameJson`
(`block`, `blockAt`, `item`, `slots`, `entity`, `player`, `inventory`, `container`, `nbt`, `entityNbt` — the
`nbt`/`entityNbt` overloads taking a `Values` walker report truncation; `pos`, `vec`; shapes mirrored by
`src/core/types.ts`), `Levels` (`requireServer(ctx)`, `level(ctx, dim)`, `levels(ctx, dim)` (one or every
level), `serverLevel`, `findEntity(ctx, args)` (by `id`/`uuid`, in `dimension` or every level),
`findEntity(level, id, uuid)`, `byUuid`, `uuid(text)`, `clientLevel()`, `clientPlayer()`, `player(ctx, name)`,
`minecraft()` — reflective, server-safe), `Reflect` (path language, overload resolution, coercion, `writeField`),
`ReflectQuery`, `Reflection` (task entry points and roots), `Handles` (`registerShared`, `existing`, `release` one or
many), `Symbols`, `Suggest`, `Registered`,
`Wait` (clocks `SERVER_TICK`, `WORLD_TICK`, `CLIENT_TICK`, `FRAME`; `untilStill`, `worldTime`), `Ticks`, `Sync`, `LongRuns`.
Client (`blockwright.minecraft.core.client`): `ClientGame` (`mc(ctx)`, `player(mc, action)`, `screen(mc,
action)`, `constant(type, value, name)`, `lower`, `screenClass`), `Settle` (`settle`, `afterTick`,
`afterServer`, `afterTickAndServer`), `View`, `HeldKeys`.

TS: the root exports `minecraft`, `MinecraftServer`, `MinecraftClient`, `MinecraftInstance`, `GameInstance`,
`CallOptions`, `defineTask`, `javaTask`, `defineModule`, `CORE`, `CORE_CLIENT`, `WORLD`, `CLIENT`, `MEDIA`,
`WaitSpec`/`WaitClock`, `SyncLedger`/`SettleOptions`, `aimGeometry` and the geometry types (`Vec3`, `Direction`,
`CameraPose`), errors, JSON types (`BlockJson`, `BlockAtJson` (`LoadedBlockAtJson` | `UnloadedBlockAtJson`), `ItemJson`, `SlotJson`, `EntityJson`, `PlayerJson`,
`InventoryJson`, `ContainerJson`) and `launchGame`. Reflection is the `reflect` namespace (`reflect.query(handle,
spec)`, …, readers `reflect.number/boolean/string`); camera presets are `camera.forBounds`, `camera.lookAt`.
`@izakyl/blockwright-minecraft/internal` has the rest: `moduleTasks`, `coreTask`, `coreClientTask`, `defined`,
`waitBudget`, `deadlineAbove`, `WAIT_SLACK_MS`, `LongRun`, `longRunId`, `stopLongRun`, `STOP_GRACE_MS`, format
helpers (`reflectText`, `numberOr`, `booleanOr`, `shortClass`, `formatDecimal`), `faceNormal`, `cameraLookingAt`,
the UI glue and the log helpers.

Reflection path language (used by `@izakyl/blockwright-ui` and library UI adapters): roots `static {className,
path}`, `handle {handle, path}`, `level`, `entity {id|uuid}`, `player {name?}`, `blockentity|blockstate
{position}` (+ `path` on all); paths of `field`, `method()`, `[i]` segments; query `{root, select, expand:
{path}, limits, handles}` → `{root, found, rootType, tree: {class, index, $id|$ref, handle?, values,
children?}, nodeCount, truncated}`. Errors throw typed errors; `reflect.queryAll` tries several roots in one hop,
each answering `{ok}` or `{error}`, and `reflect.release` frees handles.

## Tests

- Unit: `src/<area>/*.test.ts`, run by `npm test -w @izakyl/blockwright-minecraft` (`node --test 'dist/**/*.test.js'`).
  Use `FakeInstance` from `../core/fake-instance.test.js` (records ensured modules and tasks, answers runs
  from a function) with `minecraft.server(fake, { sync: new SyncLedger() })`. Test through the public API
  (`../index.js`, `../internal.js`): argument shaping, parsing, error mapping — not Java.
- Java: `./neoforge-agent/gradlew -p neoforge-agent compileModulesJava`.
- Live: one spec per area (table above), modelled on `live/minecraft-core.spec.ts`: one `launchGame` in
  `beforeAll` with the offscreen config, serial tests, distinct instance names
  (`mc-world-s`/`-c`, …) and traces under `test-results/`. Build first: `npm run build -w @izakyl/blockwright-client`
  and `npx tsc -b packages/blockwright-minecraft` (the driver binary and agent jar come from
  `npm run build:native`, `npm run build:agents`, then `npm run build:dev`, only needed after Rust/agent changes). Run one spec:
  `npx playwright test --config live/blockwright.config.ts live/minecraft-world.spec.ts`. Each launch
  starts its own driver and servers bind ephemeral ports, so specs of different areas can run at the same
  time, but a pair takes ~4 GB of RAM.
- Live UI: `live/minecraft-ui.spec.ts` drives `src/ui/` (the vanilla adapter) through `@izakyl/blockwright-ui`.

