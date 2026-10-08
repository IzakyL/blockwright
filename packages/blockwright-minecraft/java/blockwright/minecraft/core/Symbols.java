package blockwright.minecraft.core;

import static blockwright.minecraft.core.Values.obj;

import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Checks that the classes, methods and fields a prefab relies on exist in this game, so a prefab can refuse
 * early with the list of what is missing rather than fail midway. A declaration is
 * {@code {className, as?, method?, descriptor?, static?, field?}}: a class alone; a method by name (any
 * overload) or by JVM descriptor such as {@code ()Ljava/util/List;}; or a field. The answer is
 * {@code {symbols: [{...declaration, present, resolved?, reason?}], declared, missing}}.
 */
public final class Symbols {
    private Symbols() {
    }

    public static Map<String, Object> check(List<Object> declarations) {
        if (declarations == null) {
            throw Fail.invalid("symbols must be an array of declarations");
        }
        List<Object> results = new ArrayList<>();
        int missing = 0;
        for (int i = 0; i < declarations.size(); i++) {
            Map<String, Object> checked = check(Args.of(declarations.get(i), "symbols[" + i + "]"));
            if (!Boolean.TRUE.equals(checked.get("present"))) {
                missing++;
            }
            results.add(checked);
        }
        return obj("symbols", results, "declared", results.size(), "missing", missing);
    }

    private static Map<String, Object> check(Args entry) {
        String className = entry.string("className");
        String method = entry.string("method", null);
        String descriptor = entry.string("descriptor", null);
        String field = entry.string("field", null);
        boolean isStatic = entry.flag("static", false);
        Map<String, Object> checked = obj("as", entry.string("as", className), "className", className);
        if (method != null) {
            checked.put("method", method);
        }
        if (descriptor != null) {
            checked.put("descriptor", descriptor);
        }
        if (field != null) {
            checked.put("field", field);
        }
        Class<?> type;
        try {
            type = Class.forName(className, false, Symbols.class.getClassLoader());
        } catch (Throwable missing) {
            return absent(checked, "class not found: " + missing);
        }
        try {
            if (field != null) {
                resolveField(type, field);
            } else if (method != null) {
                checked.put("resolved", descriptor != null
                    ? resolveByDescriptor(type, method, descriptor, isStatic)
                    : resolveByName(type, method));
            }
            checked.put("present", true);
            return checked;
        } catch (Throwable failure) {
            return absent(checked, String.valueOf(failure));
        }
    }

    private static String resolveByDescriptor(Class<?> type, String method, String descriptor, boolean isStatic)
        throws Throwable {
        MethodType signature = MethodType.fromMethodDescriptorString(descriptor, type.getClassLoader());
        MethodHandles.Lookup lookup = MethodHandles.lookup();
        if (isStatic) {
            lookup.findStatic(type, method, signature);
        } else {
            lookup.findVirtual(type, method, signature);
        }
        return method + descriptor;
    }

    private static String resolveByName(Class<?> type, String method) throws NoSuchMethodException {
        return Reflect.findMethodNamed(type, method).toGenericString();
    }

    private static Field resolveField(Class<?> type, String name) throws NoSuchFieldException {
        for (Class<?> current = type; current != null; current = current.getSuperclass()) {
            try {
                return current.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
            }
        }
        throw new NoSuchFieldException(type.getName() + "." + name);
    }

    private static Map<String, Object> absent(Map<String, Object> checked, String reason) {
        checked.put("present", false);
        checked.put("reason", reason);
        return checked;
    }
}
