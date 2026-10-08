package blockwright.minecraft.core;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reflective paths, calls and field writes over game objects, the language reflect queries and the UI prefabs
 * speak.
 *
 * <p>A path is dot-separated segments read one after another: {@code name} reads a field (declared on the
 * class or a superclass, any visibility), {@code name()} calls a no-argument method (the class, its
 * superclasses and their interfaces, including default methods), {@code [n]} indexes an array, list or
 * collection. {@code getInstance().screen.children()[0]} is a path; so is {@code a.[2]} (the dot before an
 * index is optional). A static path starts at a static member of a class. A null midway ends the walk with a
 * message naming the segment that produced it; a missing member throws {@link NoSuchFieldException} or
 * {@link NoSuchMethodException} whose message suggests near names.
 *
 * <p>Arguments are JSON values coerced to parameter types: primitives and boxes, String, UUID, enums (by
 * name), {@code {x,y,z}} to BlockPos/Vec3i/Vec3, id strings to ResourceLocation / registered Item / Block /
 * EntityType, and {@code {"$handle": id}} to any object held by {@link Handles}. An {@code Object}
 * parameter takes the JSON value as it is (integral numbers as Integer when they fit).
 */
public final class Reflect {
    private Reflect() {
    }

    /** A resolved call: {@link #call(Object)} runs it on a receiver (ignored when static). */
    public static final class Invocation {
        public final String signature;
        public final boolean isVoid;
        public final boolean isStatic;
        private final Method method;
        private final MethodHandle handle;
        private final Object[] args;

        private Invocation(
            Method method, MethodHandle handle, String signature, boolean isVoid, boolean isStatic, Object[] args) {
            this.method = method;
            this.handle = handle;
            this.signature = signature;
            this.isVoid = isVoid;
            this.isStatic = isStatic;
            this.args = args;
        }

        private static Invocation of(Method method, boolean isStatic, Object[] args) {
            return new Invocation(
                method, null, method.toGenericString(), method.getReturnType() == void.class, isStatic, args);
        }

        private static Invocation of(MethodHandle handle, String signature, boolean isVoid, boolean isStatic, Object[] args) {
            return new Invocation(null, handle, signature, isVoid, isStatic, args);
        }

        public Object call(Object owner) throws Throwable {
            if (method != null) {
                return method.invoke(isStatic ? null : owner, args);
            }
            if (isStatic) {
                return handle.invokeWithArguments(args);
            }
            Object[] receiverAndArgs = new Object[args.length + 1];
            receiverAndArgs[0] = owner;
            System.arraycopy(args, 0, receiverAndArgs, 1, args.length);
            return handle.invokeWithArguments(receiverAndArgs);
        }
    }

    /** Follows {@code path} from {@code root}; an empty path is the root itself. */
    public static Object navigate(Object root, String path) throws Exception {
        if (path == null || path.isEmpty()) {
            return root;
        }
        return walk(root, splitPath(path), 0, path);
    }

    /** Steps through {@code segments} from index {@code from}; a null midway names the segment that produced it. */
    private static Object walk(Object start, List<String> segments, int from, String path) throws Exception {
        Object current = start;
        for (int i = from; i < segments.size(); i++) {
            String segment = segments.get(i);
            if (current == null) {
                throw pathHitNull(path, segments, i);
            }
            current = step(current, segment);
        }
        return current;
    }

    private static IllegalArgumentException pathHitNull(String path, List<String> segments, int at) {
        String reached = String.join(".", segments.subList(0, at)).replace(".[", "[");
        return new IllegalArgumentException(
            "path " + path + ": " + (reached.isEmpty() ? "the root" : reached) + " is null, so "
                + segments.get(at) + " cannot be read from it");
    }

    /** Follows {@code path} from a static member of {@code type}; null for an empty path (there is no receiver). */
    public static Object navigateStatic(Class<?> type, String path) throws Exception {
        if (path == null || path.isEmpty()) {
            return null;
        }
        List<String> segments = splitPath(path);
        return walk(staticStep(type, segments.get(0)), segments, 1, path);
    }

    private static Object staticStep(Class<?> type, String segment) throws Exception {
        if (segment.startsWith("[")) {
            throw new IllegalArgumentException(
                "a static path starts at a member of " + type.getName() + ", not at an index: " + segment);
        }
        if (segment.endsWith("()")) {
            Method method = findMethod(type, segment.substring(0, segment.length() - 2));
            requireStatic(method.getModifiers(), type, segment);
            return method.invoke(null);
        }
        Field field = findField(type, segment);
        requireStatic(field.getModifiers(), type, segment);
        return field.get(null);
    }

    private static void requireStatic(int modifiers, Class<?> type, String segment) {
        if (!Modifier.isStatic(modifiers)) {
            throw new IllegalArgumentException(
                type.getName() + "." + segment + " is not static, and a static path has no receiver to read it from");
        }
    }

    /** The segments of {@code path}: names, {@code name()} calls and {@code [n]} indices. */
    public static List<String> splitPath(String path) {
        List<String> segments = new ArrayList<>();
        StringBuilder buffer = new StringBuilder();
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '.') {
                flush(segments, buffer);
            } else if (c == '[') {
                flush(segments, buffer);
                int end = path.indexOf(']', i);
                if (end < 0) {
                    throw new IllegalArgumentException("unclosed [ in path: " + path);
                }
                segments.add(path.substring(i, end + 1));
                i = end;
            } else {
                buffer.append(c);
            }
        }
        flush(segments, buffer);
        if (segments.isEmpty()) {
            throw new IllegalArgumentException("empty path: " + path);
        }
        return segments;
    }

    private static void flush(List<String> segments, StringBuilder buffer) {
        if (buffer.length() > 0) {
            segments.add(buffer.toString());
            buffer.setLength(0);
        }
    }

    private static Object step(Object owner, String segment) throws Exception {
        if (segment.startsWith("[")) {
            int index = Integer.parseInt(segment.substring(1, segment.length() - 1).trim());
            return elementAt(owner, index);
        }
        if (segment.endsWith("()")) {
            String name = segment.substring(0, segment.length() - 2);
            Method method;
            try {
                method = findMethod(owner.getClass(), name);
            } catch (NoSuchMethodException missing) {
                throw missing;
            } catch (Throwable unusable) {
                throw new IllegalArgumentException(
                    "cannot reflectively look up method " + name + " on "
                        + owner.getClass().getName() + " (" + unusable
                        + "); try a field path to route around this class");
            }
            return method.invoke(owner);
        }
        return findField(owner.getClass(), segment).get(owner);
    }

    private static Object elementAt(Object owner, int index) {
        if (owner.getClass().isArray()) {
            return Array.get(owner, index);
        }
        if (owner instanceof List<?>) {
            return ((List<?>) owner).get(index);
        }
        if (owner instanceof Collection<?>) {
            Iterator<?> iterator = ((Collection<?>) owner).iterator();
            for (int i = 0; i < index && iterator.hasNext(); i++) {
                iterator.next();
            }
            if (!iterator.hasNext()) {
                throw new IndexOutOfBoundsException("index out of bounds: " + index);
            }
            return iterator.next();
        }
        throw new IllegalArgumentException("not an array or collection, cannot index into: " + owner.getClass().getName());
    }

    private static final Class<?>[] GUESSED_RETURN_TYPES = {
        void.class, boolean.class, int.class, long.class, double.class, float.class, String.class,
    };

    /**
     * The overload of {@code name} on {@code owner}'s class that {@code args} fit. {@code argTypes} (class
     * names, or primitive names) picks an exact overload; {@code returnType} narrows by return type.
     */
    public static Invocation resolveInvocation(
        Object owner,
        String name,
        List<Object> args,
        List<String> argTypes,
        String returnType
    ) throws Exception {
        return resolve(owner.getClass(), false, name, args, argTypes, returnType);
    }

    /** Like {@link #resolveInvocation} for a static method of {@code type}. */
    public static Invocation resolveStaticInvocation(
        Class<?> type,
        String name,
        List<Object> args,
        List<String> argTypes,
        String returnType
    ) throws Exception {
        return resolve(type, true, name, args, argTypes, returnType);
    }

    private static Invocation resolve(
        Class<?> ownerClass,
        boolean isStatic,
        String name,
        List<Object> args,
        List<String> argTypes,
        String returnType
    ) throws Exception {
        args = args == null ? List.of() : args;
        int arity = args.size();
        if (argTypes != null && argTypes.size() != arity) {
            throw new IllegalArgumentException("argTypes has " + argTypes.size() + " entries for " + arity + " argument(s)");
        }
        Class<?>[] declared = null;
        if (argTypes != null) {
            declared = new Class<?>[arity];
            for (int i = 0; i < arity; i++) {
                declared[i] = classForName(argTypes.get(i));
            }
        }

        Class<?> returns = returnType == null ? null : classForName(returnType);
        try {
            return reflectiveInvocation(ownerClass, isStatic, name, args, declared, arity, returns);
        } catch (NoSuchMethodException | IllegalArgumentException error) {
            throw error;
        } catch (Throwable reflectionUnusable) {
            // Enumerating the class failed (a sibling method names a class that is not there); look the
            // method up by its exact type instead.
        }
        return handleInvocation(ownerClass, isStatic, name, args, declared, arity, returnType);
    }

    private static Invocation reflectiveInvocation(
        Class<?> ownerClass,
        boolean isStatic,
        String name,
        List<Object> args,
        Class<?>[] declared,
        int arity,
        Class<?> returns
    ) throws Exception {
        if (declared != null) {
            Method method = findMethod(ownerClass, name, declared);
            if (isStatic && !Modifier.isStatic(method.getModifiers())) {
                throw new IllegalArgumentException(method + " is not static");
            }
            if (returns != null && method.getReturnType() != returns) {
                throw new NoSuchMethodException(
                    method.toGenericString() + " returns " + method.getReturnType().getName() + ", not " + returns.getName());
            }
            return Invocation.of(method, isStatic, coerceAll(args, method.getParameterTypes()));
        }
        List<Method> candidates = candidateMethods(ownerClass, name, arity, isStatic);
        if (returns != null) {
            candidates.removeIf(method -> method.getReturnType() != returns);
        }
        if (candidates.isEmpty()) {
            throw new NoSuchMethodException(
                ownerClass.getName() + "." + name + " has no " + (isStatic ? "static " : "")
                    + "overload taking " + arity + " argument(s)"
                    + (returns == null ? "" : " and returning " + returns.getName())
                    + Suggest.methods(ownerClass, name));
        }
        Exception lastError = null;
        for (Method candidate : candidates) {
            try {
                Object[] coerced = coerceAll(args, candidate.getParameterTypes());
                candidate.setAccessible(true);
                return Invocation.of(candidate, isStatic, coerced);
            } catch (Exception error) {
                lastError = error;
            }
        }
        throw new IllegalArgumentException(
            "arguments match no overload of " + name + ": " + (lastError == null ? "?" : lastError.getMessage()));
    }

    private static Invocation handleInvocation(
        Class<?> ownerClass,
        boolean isStatic,
        String name,
        List<Object> args,
        Class<?>[] declared,
        int arity,
        String returnType
    ) throws Exception {
        if (declared == null && arity > 0) {
            throw new IllegalArgumentException(
                "failed to enumerate methods of " + ownerClass.getName()
                    + " (most likely a sibling method references a missing class); "
                    + "the MethodHandle fallback requires explicit argTypes");
        }
        Class<?>[] parameters = declared == null ? new Class<?>[0] : declared;
        Class<?>[] returns = returnType == null
            ? GUESSED_RETURN_TYPES
            : new Class<?>[] { classForName(returnType) };

        Throwable lastError = null;
        for (Class<?> candidate : returns) {
            MethodType type = MethodType.methodType(candidate, parameters);
            try {
                MethodHandle handle = lookupHandle(ownerClass, name, type, isStatic);
                return Invocation.of(
                    handle, ownerClass.getName() + "." + name + type, candidate == void.class, isStatic,
                    coerceAll(args, parameters));
            } catch (Throwable error) {
                lastError = error;
            }
        }
        throw new IllegalArgumentException(
            "MethodHandle could not find " + (isStatic ? "static " : "") + name + parameterNames(parameters)
                + (returnType == null ? " (return type was guessed; try passing returnType)" : "")
                + ": " + (lastError == null ? "?" : lastError.toString()));
    }

    private static MethodHandle lookupHandle(Class<?> owner, String name, MethodType type, boolean isStatic)
        throws NoSuchMethodException, IllegalAccessException {
        try {
            MethodHandles.Lookup full = MethodHandles.privateLookupIn(owner, MethodHandles.lookup());
            return isStatic ? full.findStatic(owner, name, type) : full.findVirtual(owner, name, type);
        } catch (IllegalAccessException | SecurityException restricted) {
            // The owner's module does not open its package to the agent; fall back to ordinary access.
        }
        if (isStatic) {
            try {
                return MethodHandles.lookup().findStatic(owner, name, type);
            } catch (IllegalAccessException restricted) {
                return MethodHandles.publicLookup().findStatic(owner, name, type);
            }
        }
        try {
            return MethodHandles.lookup().findVirtual(owner, name, type);
        } catch (IllegalAccessException restricted) {
            return MethodHandles.publicLookup().findVirtual(owner, name, type);
        }
    }

    private static String parameterNames(Class<?>[] parameters) {
        StringBuilder text = new StringBuilder("(");
        for (int i = 0; i < parameters.length; i++) {
            text.append(i == 0 ? "" : ", ").append(parameters[i].getName());
        }
        return text.append(")").toString();
    }

    /**
     * Overloads of {@code name} on {@code type}, its superclasses and (for instance calls) every superinterface,
     * most specific first. A signature seen once shadows the same signature further up, so a class's
     * implementation wins over the interface default it overrides, as Java's own dispatch would.
     */
    private static List<Method> candidateMethods(Class<?> type, String name, int arity, boolean staticOnly) {
        List<Method> found = new ArrayList<>();
        Set<List<Class<?>>> seen = new HashSet<>();
        Deque<Class<?>> faces = new ArrayDeque<>();
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            addCandidates(type, current, name, arity, staticOnly, found, seen);
            faces.addAll(List.of(current.getInterfaces()));
        }
        // Static calls stop at the class chain: interface static methods are not inherited.
        Set<Class<?>> visited = new HashSet<>();
        for (Class<?> face; !staticOnly && (face = faces.poll()) != null; ) {
            if (visited.add(face)) {
                addCandidates(type, face, name, arity, false, found, seen);
                faces.addAll(List.of(face.getInterfaces()));
            }
        }
        return found;
    }

    private static void addCandidates(
        Class<?> type, Class<?> owner, String name, int arity, boolean staticOnly, List<Method> found, Set<List<Class<?>>> seen
    ) {
        for (Method method : owner.getDeclaredMethods()) {
            if (!method.getName().equals(name) || method.getParameterCount() != arity
                || (staticOnly && !Modifier.isStatic(method.getModifiers()))) {
                continue;
            }
            // A superinterface's static method is not a member of the receiver.
            if (owner != type && owner.isInterface() && Modifier.isStatic(method.getModifiers())) {
                continue;
            }
            List<Class<?>> signature = new ArrayList<>(List.of(method.getParameterTypes()));
            signature.add(method.getReturnType());
            if (seen.add(signature)) {
                found.add(method);
            }
        }
    }

    private static Object[] coerceAll(List<Object> args, Class<?>[] parameters) {
        Object[] coerced = new Object[parameters.length];
        for (int i = 0; i < parameters.length; i++) {
            coerced[i] = coerce(args.get(i), parameters[i]);
        }
        return coerced;
    }

    /** Sets static field {@code name} of {@code type}; answers the previous value. */
    public static Object writeStaticField(Class<?> type, String name, Object value) throws Exception {
        Field field = findField(type, name);
        if (!Modifier.isStatic(field.getModifiers())) {
            throw new IllegalArgumentException(type.getName() + "." + name + " is not static");
        }
        Object previous = field.get(null);
        field.set(null, coerce(value, field.getType()));
        return previous;
    }

    /** Sets field {@code name} of {@code owner} to {@code value} (coerced); answers the previous value. */
    public static Object writeField(Object owner, String name, Object value) throws Exception {
        Field field = findField(owner.getClass(), name);
        Object previous = field.get(owner);
        field.set(owner, coerce(value, field.getType()));
        return previous;
    }

    /** {@code value} (a JSON value as a task receives it) as a {@code target}. */
    public static Object coerce(Object value, Class<?> target) {
        if (value == null) {
            if (target.isPrimitive()) {
                throw new IllegalArgumentException("primitive type " + target.getName() + " cannot accept null");
            }
            return null;
        }
        if (value instanceof Map<?, ?> map && map.get("$handle") instanceof String id) {
            Object object = Handles.resolve(id);
            if (target == Object.class || boxed(target).isInstance(object)) {
                return object;
            }
            throw new IllegalArgumentException(
                "handle " + id + " holds a " + object.getClass().getName() + ", which is not a " + target.getName());
        }
        if (target == Object.class) {
            return value instanceof Long whole && whole == (int) (long) whole ? Integer.valueOf((int) (long) whole) : value;
        }
        if (target == boolean.class || target == Boolean.class) {
            if (value instanceof Boolean flag) {
                return flag;
            }
            throw mismatch(value, target);
        }
        if (value instanceof Number number) {
            if (target == int.class || target == Integer.class) {
                return number.intValue();
            }
            if (target == long.class || target == Long.class) {
                return number.longValue();
            }
            if (target == double.class || target == Double.class) {
                return number.doubleValue();
            }
            if (target == float.class || target == Float.class) {
                return number.floatValue();
            }
            if (target == short.class || target == Short.class) {
                return number.shortValue();
            }
            if (target == byte.class || target == Byte.class) {
                return number.byteValue();
            }
        }
        if (value instanceof String text) {
            if (target == String.class || target == CharSequence.class) {
                return text;
            }
            if (target == char.class || target == Character.class) {
                if (text.length() != 1) {
                    throw new IllegalArgumentException("char requires a string of length 1");
                }
                return text.charAt(0);
            }
            if (target == UUID.class) {
                return UUID.fromString(text);
            }
            if (target.isEnum()) {
                return enumOf(target, text);
            }
            Object registered = Registered.of(target, text);
            if (registered != null) {
                return registered;
            }
        }
        if (value instanceof Map<?, ?> map) {
            Object vector = vectorOf(map, target);
            if (vector != null) {
                return vector;
            }
        }
        if (boxed(target).isInstance(value)) {
            return value;
        }
        throw mismatch(value, target);
    }

    private static IllegalArgumentException mismatch(Object value, Class<?> target) {
        return new IllegalArgumentException(
            "cannot pass " + Args.describe(value) + " as a " + target.getName()
                + " (pass {\"$handle\": ...} from a handle to supply any object)");
    }

    private static Class<?> boxed(Class<?> type) {
        return type.isPrimitive() ? MethodType.methodType(type).wrap().returnType() : type;
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static Object enumOf(Class<?> target, String name) {
        return Enum.valueOf((Class<? extends Enum>) target, name);
    }

    private static Object vectorOf(Map<?, ?> value, Class<?> target) {
        if (!(value.get("x") instanceof Number x) || !(value.get("y") instanceof Number y)
            || !(value.get("z") instanceof Number z)) {
            return null;
        }
        String name = target.getName();
        try {
            if (name.equals("net.minecraft.core.BlockPos") || name.equals("net.minecraft.core.Vec3i")) {
                return target.getConstructor(int.class, int.class, int.class)
                    .newInstance(x.intValue(), y.intValue(), z.intValue());
            }
            if (name.equals("net.minecraft.world.phys.Vec3")) {
                return target.getConstructor(double.class, double.class, double.class)
                    .newInstance(x.doubleValue(), y.doubleValue(), z.doubleValue());
            }
        } catch (ReflectiveOperationException error) {
            throw new IllegalArgumentException("failed to construct " + name + ": " + error.getMessage());
        }
        return null;
    }

    /** A class by binary name as the game sees it, or a primitive by its keyword. */
    public static Class<?> classForName(String name) throws ClassNotFoundException {
        switch (name) {
            case "void":
                return void.class;
            case "int":
                return int.class;
            case "long":
                return long.class;
            case "double":
                return double.class;
            case "float":
                return float.class;
            case "short":
                return short.class;
            case "byte":
                return byte.class;
            case "char":
                return char.class;
            case "boolean":
                return boolean.class;
            default:
                return Class.forName(name, false, Reflect.class.getClassLoader());
        }
    }

    private static final Map<MethodKey, Optional<Method>> METHOD_CACHE = new ConcurrentHashMap<>();
    private static final Map<String, Optional<Field>> FIELD_CACHE = new ConcurrentHashMap<>();

    private record MethodKey(Class<?> type, String name, List<Class<?>> parameters) {
    }

    /** A declared method on {@code type} or a supertype, including interface default methods. */
    /** Any overload of {@code name} declared on {@code type}, its superclasses or their interfaces. */
    public static Method findMethodNamed(Class<?> type, String name) throws NoSuchMethodException {
        Deque<Class<?>> faces = new ArrayDeque<>();
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            for (Method method : current.getDeclaredMethods()) {
                if (method.getName().equals(name)) {
                    return method;
                }
            }
            faces.addAll(List.of(current.getInterfaces()));
        }
        Set<Class<?>> visited = new HashSet<>();
        for (Class<?> face; (face = faces.poll()) != null; ) {
            if (visited.add(face)) {
                for (Method method : face.getDeclaredMethods()) {
                    if (method.getName().equals(name)) {
                        return method;
                    }
                }
                faces.addAll(List.of(face.getInterfaces()));
            }
        }
        throw new NoSuchMethodException(type.getName() + "." + name + " does not exist" + Suggest.methods(type, name));
    }

    /** A method declared on {@code type}, a superclass or an interface (default methods too), made accessible. */
    public static Method findMethod(Class<?> type, String name, Class<?>... parameters) throws NoSuchMethodException {
        Optional<Method> found = METHOD_CACHE.computeIfAbsent(new MethodKey(type, name, List.of(parameters)), key -> {
            Deque<Class<?>> faces = new ArrayDeque<>();
            for (Class<?> current = type; current != null; current = current.getSuperclass()) {
                Method method = declaredMethod(current, name, parameters);
                if (method != null) {
                    return Optional.of(method);
                }
                faces.addAll(List.of(current.getInterfaces()));
            }
            // Default methods live on interfaces, which the superclass walk never visits.
            for (Class<?> face; (face = faces.poll()) != null; ) {
                Method method = declaredMethod(face, name, parameters);
                if (method != null) {
                    return Optional.of(method);
                }
                faces.addAll(List.of(face.getInterfaces()));
            }
            return Optional.empty();
        });
        return found.orElseThrow(() -> new NoSuchMethodException(
            type.getName() + "." + name + parameterNames(parameters) + " does not exist" + Suggest.methods(type, name)));
    }

    private static Method declaredMethod(Class<?> type, String name, Class<?>[] parameters) {
        try {
            Method method = type.getDeclaredMethod(name, parameters);
            method.setAccessible(true);
            return method;
        } catch (NoSuchMethodException missing) {
            return null;
        }
    }

    /** A field declared on {@code type} or a superclass, made accessible. */
    public static Field findField(Class<?> type, String name) throws NoSuchFieldException {
        Optional<Field> found = FIELD_CACHE.computeIfAbsent(type.getName() + '#' + name, key -> {
            for (Class<?> current = type; current != null; current = current.getSuperclass()) {
                try {
                    Field field = current.getDeclaredField(name);
                    field.setAccessible(true);
                    return Optional.of(field);
                } catch (NoSuchFieldException next) {
                }
            }
            return Optional.empty();
        });
        return found.orElseThrow(() -> new NoSuchFieldException(
            type.getName() + " has no field " + name + Suggest.fields(type, name)));
    }
}
