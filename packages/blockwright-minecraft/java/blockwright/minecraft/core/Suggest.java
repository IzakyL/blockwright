package blockwright.minecraft.core;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** The members a mistyped or renamed reflection target most likely meant, appended to a not-found message. */
public final class Suggest {
    private static final int MAX = 8;

    private Suggest() {
    }

    /** "; …" naming a method of that name (a missing {@code ()}) or fields with similar names; "" when there are none. */
    public static String fields(Class<?> type, String name) {
        try {
            for (Method method : methodsOf(type)) {
                if (method.getName().equals(name) && method.getParameterCount() == 0) {
                    return "; " + name + " is a method, write it as " + name + "()";
                }
            }
            Set<String> names = new LinkedHashSet<>();
            for (Class<?> current = type; current != null; current = current.getSuperclass()) {
                for (Field field : current.getDeclaredFields()) {
                    names.add(field.getName());
                }
            }
            List<String> near = near(names, name);
            return near.isEmpty() ? "" : "; similar fields: " + String.join(", ", near);
        } catch (Throwable unusable) {
            return "";
        }
    }

    /** "; …" listing the overloads of {@code name}, a field of that name, or methods with similar names. */
    public static String methods(Class<?> type, String name) {
        try {
            List<Method> methods = methodsOf(type);
            Set<String> overloads = new LinkedHashSet<>();
            Set<String> names = new LinkedHashSet<>();
            for (Method method : methods) {
                names.add(method.getName());
                if (method.getName().equals(name)) {
                    overloads.add(signature(method));
                }
            }
            if (!overloads.isEmpty()) {
                return "; overloads: " + String.join(", ", overloads.stream().limit(MAX).toList());
            }
            for (Class<?> current = type; current != null; current = current.getSuperclass()) {
                for (Field field : current.getDeclaredFields()) {
                    if (field.getName().equals(name)) {
                        return "; " + name + " is a field, read it without ()";
                    }
                }
            }
            List<String> near = near(names, name);
            return near.isEmpty() ? "" : "; similar methods: " + String.join(", ", near);
        } catch (Throwable unusable) {
            return "";
        }
    }

    private static List<Method> methodsOf(Class<?> type) {
        List<Method> methods = new ArrayList<>();
        Deque<Class<?>> faces = new ArrayDeque<>();
        Set<Class<?>> visited = new LinkedHashSet<>();
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            methods.addAll(List.of(current.getDeclaredMethods()));
            faces.addAll(List.of(current.getInterfaces()));
        }
        for (Class<?> face; (face = faces.poll()) != null; ) {
            if (visited.add(face)) {
                methods.addAll(List.of(face.getDeclaredMethods()));
                faces.addAll(List.of(face.getInterfaces()));
            }
        }
        methods.removeIf(Method::isSynthetic);
        return methods;
    }

    private static String signature(Method method) {
        StringBuilder text = new StringBuilder(method.getName()).append('(');
        Class<?>[] parameters = method.getParameterTypes();
        for (int i = 0; i < parameters.length; i++) {
            text.append(i == 0 ? "" : ", ").append(parameters[i].getSimpleName());
        }
        return text.append(')').toString();
    }

    /** Names within a small edit distance of {@code wanted}, or sharing a case-insensitive substring with it. */
    public static List<String> near(Set<String> names, String wanted) {
        String lower = wanted.toLowerCase();
        int budget = Math.max(1, wanted.length() / 3);
        List<String> found = new ArrayList<>();
        for (String name : names) {
            if (name.equals(wanted)) {
                continue;
            }
            String other = name.toLowerCase();
            boolean contains = lower.length() >= 3 && other.length() >= 3 && (other.contains(lower) || lower.contains(other));
            if (contains || distance(lower, other) <= budget) {
                found.add(name);
            }
        }
        found.sort(Comparator.comparingInt(name -> distance(lower, name.toLowerCase())));
        return found.size() > MAX ? found.subList(0, MAX) : found;
    }

    private static int distance(String a, String b) {
        int[] previous = new int[b.length() + 1];
        int[] current = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            previous[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            current[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                current[j] = Math.min(Math.min(current[j - 1] + 1, previous[j] + 1), previous[j - 1] + cost);
            }
            int[] swap = previous;
            previous = current;
            current = swap;
        }
        return previous[b.length()];
    }
}
