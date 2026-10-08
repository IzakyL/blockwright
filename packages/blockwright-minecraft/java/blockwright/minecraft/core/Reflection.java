package blockwright.minecraft.core;

import static blockwright.minecraft.core.Values.obj;

import dev.blockwright.api.Context;
import dev.blockwright.api.TaskException;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;

import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The reflect operations as task entry points: {@link #query}, {@link #queryAll}, {@link #invoke},
 * {@link #setField}, {@link #release}; {@link Symbols#check} checks declarations. Each takes the call's
 * arguments as {@link Args} and answers a JSON-ready map. Run them on the thread that owns what they touch
 * (server tasks on the server thread, client tasks on the client thread).
 *
 * <p>A root (a query's {@code root}, an invoke's or setField's {@code target}) is one of:
 * <ul>
 * <li>{@code {kind: "static", className, path?}} — a static member path (no path: the class itself, for static calls)</li>
 * <li>{@code {kind: "handle", handle, path?}}</li>
 * <li>{@code {kind: "level", dimension?}}</li>
 * <li>{@code {kind: "entity", id? | uuid?, dimension?}}</li>
 * <li>{@code {kind: "player", name?}} — the server's player by name (first player when omitted), or the client's own</li>
 * <li>{@code {kind: "blockentity" | "blockstate", position: {x,y,z}, dimension?}}</li>
 * </ul>
 * and every kind takes a {@code path} followed from it. Levels, entities and blocks come from the server
 * level where this instance runs a server, else from the client's level (see {@link Levels#level}).
 *
 * <p>Failures end the run: {@code invalid} for bad arguments or arguments no overload accepts,
 * {@code not-found} for a missing class, member or handle, {@code reflect} (detail {@code {exception, trace}})
 * when the called method itself threw.
 */
public final class Reflection {
    private Reflection() {
    }

    /**
     * {@code {root: <resolved root description>, found, rootType?, tree, nodeCount, truncated}}; a root that
     * resolves to nothing (no such entity, null at the end of the root's path) answers {@code found: false}.
     */
    public static Map<String, Object> query(Context ctx, Args spec) {
        return guard(() -> {
            if (!spec.has("select") && !spec.has("expand")) {
                throw Fail.invalid("a reflect query needs select or expand");
            }
            ReflectQuery query = ReflectQuery.of(spec);
            Map<String, Object> resolved = new LinkedHashMap<>();
            Object subject = resolveRoot(ctx, spec.requireObject("root"), spec.string("dimension", null), resolved);
            Map<String, Object> result = obj("root", resolved, "found", subject != null);
            if (subject == null) {
                result.put("tree", null);
                result.put("nodeCount", 0);
                result.put("truncated", false);
                return result;
            }
            result.put("rootType", subject.getClass().getName());
            result.put("tree", query.walk(subject));
            result.put("nodeCount", query.nodeCount());
            result.put("truncated", query.truncated());
            return result;
        });
    }

    /**
     * Several queries in one hop, so they read the same tick or frame: {@code queries: {name: spec}} answers
     * {@code {name: {ok: result} | {error: {code, message}}}}; one failing query does not fail the others.
     */
    public static Map<String, Object> queryAll(Context ctx, Args spec) {
        Args queries = spec.requireObject("queries");
        Map<String, Object> results = new LinkedHashMap<>();
        for (String name : queries.raw().keySet()) {
            try {
                results.put(name, obj("ok", query(ctx, queries.requireObject(name))));
            } catch (TaskException failure) {
                results.put(name, obj("error", obj("code", failure.code(), "message", failure.getMessage())));
            }
        }
        return results;
    }

    /**
     * Calls {@code method} on the object {@code target} and {@code path} lead to (a static target without a
     * path calls a static method of its class). {@code args}, {@code argTypes}, {@code returnType} pick the
     * overload; {@code returnHandle} keeps the returned object as a handle; {@code limits} bound the walk of
     * the return value. Answers {@code {target, found, ownerType, signature, void, returned, returnedType?,
     * handle?, handleType?}}. An argument {@code {"$level": dimension|true}} passes that level.
     */
    public static Map<String, Object> invoke(Context ctx, Args spec) {
        return guard(() -> {
            Args target = spec.requireObject("target");
            String method = spec.string("method");
            String path = spec.string("path", null);
            String dimension = spec.string("dimension", null);
            List<Object> args = levelArgs(ctx, spec.list("args"), dimension);
            List<String> argTypes = spec.strings("argTypes");
            String returnType = spec.string("returnType", null);
            Map<String, Object> resolved = new LinkedHashMap<>();
            Map<String, Object> result = obj("target", resolved);
            Object owner;
            Reflect.Invocation invocation;
            if ("static".equals(target.string("kind"))) {
                String className = target.string("className");
                String staticPath = joinPath(target.string("path", null), path);
                resolved.put("kind", "static");
                resolved.put("className", className);
                Class<?> type = Reflect.classForName(className);
                result.put("found", true);
                if (staticPath == null) {
                    owner = null;
                    result.put("ownerType", className);
                    invocation = Reflect.resolveStaticInvocation(type, method, args, argTypes, returnType);
                } else {
                    resolved.put("path", staticPath);
                    owner = Reflect.navigateStatic(type, staticPath);
                    if (owner == null) {
                        throw Fail.notFound("path " + className + "." + staticPath + " resolved to null");
                    }
                    result.put("ownerType", owner.getClass().getName());
                    invocation = Reflect.resolveInvocation(owner, method, args, argTypes, returnType);
                }
            } else {
                Object subject = resolveRoot(ctx, target, dimension, resolved);
                result.put("found", subject != null);
                if (subject == null) {
                    return result;
                }
                owner = Reflect.navigate(subject, path);
                if (owner == null) {
                    throw Fail.notFound("path " + path + " resolved to null");
                }
                result.put("ownerType", owner.getClass().getName());
                invocation = Reflect.resolveInvocation(owner, method, args, argTypes, returnType);
            }
            result.put("signature", invocation.signature);
            Object returned;
            try {
                returned = invocation.call(owner);
            } catch (Throwable thrown) {
                throw threw(invocation.signature, thrown);
            }
            result.put("void", invocation.isVoid);
            if (invocation.isVoid || returned == null) {
                result.put("returned", null);
                return result;
            }
            result.put("returnedType", returned.getClass().getName());
            if (spec.flag("returnHandle", false)) {
                result.put("handle", Handles.register(returned));
                result.put("handleType", returned.getClass().getName());
            }
            result.put("returned", new Values(Values.Limits.of(spec.object("limits"))).encode(returned));
            return result;
        });
    }

    /**
     * Sets {@code field} of the object {@code target} and {@code path} lead to, to {@code value} (coerced as
     * an argument would be). Answers {@code {target, found, ownerType, field, previous}} ({@code previous} as a
     * {@link Values} leaf).
     */
    public static Map<String, Object> setField(Context ctx, Args spec) {
        return guard(() -> {
            String field = spec.string("field");
            if (!spec.raw().containsKey("value")) {
                throw Fail.invalid("setField needs a value");
            }
            Args target = spec.requireObject("target");
            String path = spec.string("path", null);
            Map<String, Object> resolved = new LinkedHashMap<>();
            Map<String, Object> result = obj("target", resolved);
            Object previous;
            if ("static".equals(target.string("kind"))) {
                String className = target.string("className");
                String staticPath = joinPath(target.string("path", null), path);
                resolved.put("kind", "static");
                resolved.put("className", className);
                Class<?> type = Reflect.classForName(className);
                result.put("found", true);
                if (staticPath == null) {
                    result.put("ownerType", className);
                    previous = Reflect.writeStaticField(type, field, spec.value("value"));
                } else {
                    resolved.put("path", staticPath);
                    Object owner = Reflect.navigateStatic(type, staticPath);
                    if (owner == null) {
                        throw Fail.notFound("path " + className + "." + staticPath + " resolved to null");
                    }
                    result.put("ownerType", owner.getClass().getName());
                    previous = Reflect.writeField(owner, field, spec.value("value"));
                }
            } else {
                Object subject = resolveRoot(ctx, target, spec.string("dimension", null), resolved);
                result.put("found", subject != null);
                if (subject == null) {
                    return result;
                }
                Object owner = Reflect.navigate(subject, path);
                if (owner == null) {
                    throw Fail.notFound("path " + path + " resolved to null");
                }
                result.put("ownerType", owner.getClass().getName());
                previous = Reflect.writeField(owner, field, spec.value("value"));
            }
            result.put("field", field);
            result.put("previous", new Values().leaf(previous));
            return result;
        });
    }

    /** {@code {handle}} releases one handle, {@code {all: true}} every one; answers {@code {released: n}}. */
    public static Map<String, Object> release(Args spec) {
        if (spec.flag("all", false)) {
            return obj("released", Handles.clear());
        }
        return obj("released", Handles.release(spec.string("handle")) ? 1 : 0);
    }

    /**
     * The object {@code root} names, recording what it resolved into {@code resolved}; null when the root's
     * subject does not exist (an entity that is gone, an empty block entity position, a null at the end of
     * its path). Throws for an invalid root.
     */
    public static Object resolveRoot(Context ctx, Args root, String dimension, Map<String, Object> resolved) throws Exception {
        String kind = root.string("kind");
        String path = root.string("path", null);
        String inDimension = root.string("dimension", dimension);
        resolved.put("kind", kind);
        Object subject = switch (kind) {
            case "static" -> {
                String className = root.string("className");
                resolved.put("className", className);
                yield Reflect.navigateStatic(Reflect.classForName(className), path);
            }
            case "handle" -> {
                String id = root.string("handle");
                Object object = Handles.resolve(id);
                resolved.put("handle", id);
                resolved.put("handleType", object.getClass().getName());
                yield object;
            }
            case "level" -> {
                Level level = Levels.level(ctx, inDimension);
                resolved.put("dimension", Levels.dimension(level));
                yield level;
            }
            case "entity" -> entity(ctx, root, inDimension, resolved);
            case "player" -> {
                String name = root.string("name", null);
                if (name != null) {
                    resolved.put("name", name);
                }
                Player player = Levels.player(ctx, name);
                if (player != null) {
                    resolved.put("uuid", String.valueOf(player.getUUID()));
                }
                yield player;
            }
            case "blockentity", "block_entity" -> {
                Level level = Levels.level(ctx, inDimension);
                BlockPos pos = root.blockPos("position");
                resolved.put("position", GameJson.pos(pos));
                BlockEntity blockEntity = level.getBlockEntity(pos);
                if (blockEntity != null) {
                    resolved.put("registryType", String.valueOf(BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(blockEntity.getType())));
                }
                yield blockEntity;
            }
            case "blockstate", "block_state" -> {
                Level level = Levels.level(ctx, inDimension);
                BlockPos pos = root.blockPos("position");
                resolved.put("position", GameJson.pos(pos));
                BlockState state = level.getBlockState(pos);
                resolved.put("state", String.valueOf(state));
                yield state;
            }
            default -> throw Fail.invalid(
                "root kind must be static, handle, level, entity, player, blockentity or blockstate; got " + kind);
        };
        if (subject == null || "static".equals(kind) || path == null || path.isEmpty()) {
            if (path != null && !path.isEmpty()) {
                resolved.put("path", path);
            }
            return subject;
        }
        resolved.put("path", path);
        return Reflect.navigate(subject, path);
    }

    private static Entity entity(Context ctx, Args root, String dimension, Map<String, Object> resolved) {
        if (!root.has("id") && !root.has("uuid")) {
            throw Fail.invalid("an entity root needs id or uuid");
        }
        Level level = Levels.level(ctx, dimension);
        Entity entity = null;
        if (root.has("id")) {
            int id = (int) root.integer("id");
            resolved.put("id", id);
            entity = level.getEntity(id);
        }
        if (entity == null && root.has("uuid")) {
            String text = root.string("uuid");
            resolved.put("uuid", text);
            entity = Levels.byUuid(level, Levels.uuid(text));
        }
        if (entity != null) {
            resolved.put("type", GameJson.entityTypeId(entity.getType()));
        }
        return entity;
    }

    private static String joinPath(String first, String second) {
        boolean hasFirst = first != null && !first.isEmpty();
        boolean hasSecond = second != null && !second.isEmpty();
        if (hasFirst && hasSecond) {
            return second.startsWith("[") ? first + second : first + "." + second;
        }
        return hasFirst ? first : hasSecond ? second : null;
    }

    private static List<Object> levelArgs(Context ctx, List<Object> args, String dimension) {
        if (args == null) {
            return List.of();
        }
        List<Object> substituted = new ArrayList<>(args.size());
        for (Object arg : args) {
            if (arg instanceof Map<?, ?> map && map.containsKey("$level")) {
                Object named = map.get("$level");
                Level level = Levels.level(ctx, named instanceof String text ? text : dimension);
                substituted.add(obj("$handle", Handles.registerShared(level)));
            } else {
                substituted.add(arg);
            }
        }
        return substituted;
    }

    /** Runs {@code body}, turning reflective failures into the prefab's error codes. */
    public static <T> T guard(Callable<T> body) {
        try {
            return body.call();
        } catch (TaskException failure) {
            throw failure;
        } catch (NoSuchFieldException | NoSuchMethodException | ClassNotFoundException missing) {
            throw Fail.notFound(missing.getMessage() == null ? String.valueOf(missing) : missing.getMessage());
        } catch (IllegalArgumentException | IndexOutOfBoundsException | ClassCastException invalid) {
            throw Fail.invalid(String.valueOf(invalid.getMessage()));
        } catch (Throwable error) {
            Throwable cause = Fail.unwrap(error);
            if (cause instanceof TaskException failure) {
                throw failure;
            }
            throw threw("a reflective read", cause);
        }
    }

    private static TaskException threw(String what, Throwable thrown) {
        Throwable cause = Fail.unwrap(thrown);
        if (cause instanceof TaskException failure) {
            return failure;
        }
        StringWriter trace = new StringWriter();
        cause.printStackTrace(new PrintWriter(trace));
        String text = trace.toString();
        return new TaskException(Fail.REFLECT, what + " threw " + cause,
            obj("exception", cause.getClass().getName(), "trace", text.length() > 8000 ? text.substring(0, 8000) : text));
    }
}
