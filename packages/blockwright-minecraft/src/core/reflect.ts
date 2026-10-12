import type { CallOptions, MinecraftInstance } from "./binding.js";
import { defineTask, javaTask } from "./task.js";
import type { Vec3 } from "./geometry.js";

/** Bounds on the value walker (Values.java); each omitted field keeps its default. */
export interface ValueLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxItems?: number;
  maxFields?: number;
  stringLimit?: number;
}

/**
 * Where a reflective operation starts (Reflection.java). Every kind takes a `path` followed from it:
 * dot-separated `field`, `method()` and `[index]` segments. Levels, entities and blocks come from the
 * server level on a server and from the client's level on a client.
 */
export type ReflectRoot =
  | { kind: "static"; className: string; path?: string }
  | { kind: "handle"; handle: string; path?: string }
  | { kind: "level"; dimension?: string; path?: string }
  | { kind: "entity"; id?: number; uuid?: string; dimension?: string; path?: string }
  | { kind: "player"; name?: string; path?: string }
  | { kind: "blockentity" | "blockstate"; position: Vec3; dimension?: string; path?: string };

export interface ReflectQuerySpec {
  root: ReflectRoot;
  /** Named paths read on every node, as leaves. */
  select?: Record<string, string>;
  /** Children: the path's value (iterable, array or one object) on every node, walked while maxDepth allows. */
  expand?: { path: string };
  limits?: ValueLimits;
  /** Report a handle for every node. */
  handles?: boolean;
  dimension?: string;
}

export interface ReflectQueryNode {
  class: string;
  index: number;
  $id?: number;
  /** Set instead of values/children when the node repeats an object shown as node `$ref`. */
  $ref?: number;
  handle?: string;
  /** Each selected path's leaf; `{$absent: true}` when the object lacks the member, `{$error}` when it threw. */
  values?: Record<string, unknown>;
  children?: ReflectQueryNode[];
}

export interface ReflectQueryResult {
  /** What the root resolved to (kind, ids, the entity type, ...). */
  root: Record<string, unknown>;
  found: boolean;
  rootType?: string;
  tree: ReflectQueryNode | null;
  nodeCount: number;
  truncated: boolean;
}

export type ReflectQueryOutcome =
  | { ok: ReflectQueryResult; error?: undefined }
  | { ok?: undefined; error: { code: string; message: string } };

export interface InvokeSpec {
  /** The receiver's root; a static root without a path calls a static method. */
  target: ReflectRoot;
  path?: string;
  method: string;
  /** JSON arguments; `{$handle: id}` passes a handle's object, `{$level: dimension | true}` a level. */
  args?: unknown[];
  /** Exact parameter types (class names or primitives), to pick an overload. */
  argTypes?: string[];
  returnType?: string;
  /** Keep the returned object as a handle. */
  returnHandle?: boolean;
  limits?: ValueLimits;
  dimension?: string;
}

export interface InvokeResult {
  target: Record<string, unknown>;
  found: boolean;
  ownerType?: string;
  signature?: string;
  void?: boolean;
  /** The return value walked by the value walker (null for void). */
  returned?: unknown;
  returnedType?: string;
  handle?: string;
  handleType?: string;
}

export interface SetFieldSpec {
  target: ReflectRoot;
  path?: string;
  field: string;
  value: unknown;
  dimension?: string;
}

export interface SetFieldResult {
  target: Record<string, unknown>;
  found: boolean;
  ownerType?: string;
  field?: string;
  previous?: unknown;
}

export interface SymbolDeclaration {
  as?: string;
  className: string;
  method?: string;
  /** JVM descriptor, e.g. `()Ljava/util/List;`. */
  descriptor?: string;
  field?: string;
  static?: boolean;
}

export interface SymbolCheck extends SymbolDeclaration {
  present: boolean;
  resolved?: string;
  reason?: string;
}

export interface SymbolsResult {
  symbols: SymbolCheck[];
  declared: number;
  missing: number;
}

const body = (call: string) => `return ${call};`;
/** Writes on a server advance its epoch (clients settle to it); on a client there is nothing to stamp. */
const stamped = (call: string) => `Object result = ${call};\nreturn ctx.server() != null ? Sync.stamp(result) : result;`;

export const REFLECT_QUERY = defineTask<ReflectQuerySpec, ReflectQueryResult>({
  name: "reflect.query",
  side: "any",
  source: javaTask({ body: body("Reflection.query(ctx, Args.of(ctx))") }),
});

export const REFLECT_QUERY_ALL = defineTask<{ queries: Record<string, ReflectQuerySpec> }, Record<string, ReflectQueryOutcome>>({
  name: "reflect.queryAll",
  side: "any",
  source: javaTask({ body: body("Reflection.queryAll(ctx, Args.of(ctx))") }),
});

export const REFLECT_INVOKE = defineTask<InvokeSpec, InvokeResult>({
  name: "reflect.invoke",
  side: "any",
  source: javaTask({ body: stamped("Reflection.invoke(ctx, Args.of(ctx))") }),
});

export const REFLECT_SET_FIELD = defineTask<SetFieldSpec, SetFieldResult>({
  name: "reflect.setField",
  side: "any",
  source: javaTask({ body: stamped("Reflection.setField(ctx, Args.of(ctx))") }),
});

export const REFLECT_SYMBOLS = defineTask<{ symbols: SymbolDeclaration[] }, SymbolsResult>({
  name: "reflect.symbols",
  side: "any",
  // Class lookups only: no game thread needed, and no settling.
  thread: "worker",
  settle: false,
  source: javaTask({ body: body(`Symbols.check(Args.of(ctx).list("symbols"))`) }),
});

export const REFLECT_RELEASE = defineTask<{ handle?: string; all?: boolean }, { released: number }>({
  name: "reflect.release",
  side: "any",
  thread: "worker",
  settle: false,
  source: javaTask({ body: body("Reflection.release(Args.of(ctx))") }),
});

// Reflection on one instance, on its game thread (server or client).

export function reflectQuery(handle: MinecraftInstance, spec: ReflectQuerySpec, options: CallOptions = {}): Promise<ReflectQueryResult> {
  return handle.run(REFLECT_QUERY, spec, options);
}

/** Several queries in one hop (same tick or frame); each answers `ok` or `error` on its own. */
export function reflectQueryAll(
  handle: MinecraftInstance,
  queries: Record<string, ReflectQuerySpec>,
  options: CallOptions = {},
): Promise<Record<string, ReflectQueryOutcome>> {
  return handle.run(REFLECT_QUERY_ALL, { queries }, options);
}

export function reflectInvoke(handle: MinecraftInstance, spec: InvokeSpec, options: CallOptions = {}): Promise<InvokeResult> {
  return handle.run(REFLECT_INVOKE, spec, options);
}

export function reflectSetField(handle: MinecraftInstance, spec: SetFieldSpec, options: CallOptions = {}): Promise<SetFieldResult> {
  return handle.run(REFLECT_SET_FIELD, spec, options);
}

export function reflectSymbols(handle: MinecraftInstance, symbols: SymbolDeclaration[], options: CallOptions = {}): Promise<SymbolsResult> {
  return handle.run(REFLECT_SYMBOLS, { symbols }, options);
}

/** Frees one handle, or every handle of the instance. */
export function reflectRelease(
  handle: MinecraftInstance,
  target: string | { all: true },
  options: CallOptions = {},
): Promise<{ released: number }> {
  return handle.run(REFLECT_RELEASE, typeof target === "string" ? { handle: target } : { all: true }, options);
}

export interface ReflectDumpSpec {
  /** The object to dump: an entity, a block entity, a player, a level, or a handle from an earlier query. */
  target: ReflectRoot;
  dimension?: string;
  /** How deep and wide the value walker goes. */
  limits?: ValueLimits;
}

export interface ReflectDump {
  found: boolean;
  /** The object's fields as a value tree, within the limits; undefined when it was not found. */
  tree: unknown;
}

/**
 * The whole object behind `target` as a value tree (its fields, walked by the value walker within `limits`),
 * for looking at state no query path was written for. A {@link reflectQuery} reads chosen paths and is the
 * cheaper call once the paths are known.
 */
export async function reflectDump(handle: MinecraftInstance, spec: ReflectDumpSpec, options: CallOptions = {}): Promise<ReflectDump> {
  const { target, dimension, limits } = spec;
  let held: string | undefined;
  let pinned = false;
  if (target.kind === "handle" && target.path === undefined) {
    held = target.handle;
  } else {
    const root = await reflectQuery(handle, { root: target, select: {}, handles: true, ...(dimension !== undefined ? { dimension } : {}) }, options);
    const found = root as { found?: boolean; tree?: { handle?: string } };
    if (found.found === false || !found.tree?.handle) return { found: false, tree: undefined };
    held = found.tree.handle;
    pinned = true;
  }
  try {
    const dumped = await reflectInvoke(handle, {
      target: { kind: "static", className: "java.util.Objects" },
      method: "requireNonNull",
      args: [{ $handle: held }],
      argTypes: ["java.lang.Object"],
      ...(limits !== undefined ? { limits } : {}),
    }, options);
    return { found: true, tree: dumped.returned };
  } finally {
    if (pinned) await reflectRelease(handle, held).catch(() => undefined);
  }
}
