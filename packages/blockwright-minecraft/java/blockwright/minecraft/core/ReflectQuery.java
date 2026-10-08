package blockwright.minecraft.core;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A reflect query walk from one root object: every node reports its {@code class}, its {@code index} among its
 * siblings, an {@code $id} (or {@code $ref} to the node that already showed the same object), its
 * {@code handle} when handles are on, the {@code values} its {@code select} paths read (as {@link Values}
 * leaves; {@code {"$absent": true}} for a member the object lacks, {@code {"$error": ...}} for a read that
 * threw) and the {@code children} found by following the {@code expand} path (an iterable, array or single
 * object) while {@code maxDepth} allows.
 */
public final class ReflectQuery {
    private final String expandPath;
    private final Map<String, String> select;
    private final boolean handles;
    private final Values values;
    private final IdentityHashMap<Object, Integer> seen = new IdentityHashMap<>();

    public ReflectQuery(Map<String, String> select, String expandPath, Values.Limits limits, boolean handles) {
        this.expandPath = expandPath == null || expandPath.isBlank() ? null : expandPath;
        this.select = select == null ? Map.of() : select;
        this.handles = handles;
        this.values = new Values(limits, handles);
    }

    /** The walk a call's {@code select}, {@code expand: {path}}, {@code limits} and {@code handles} describe. */
    public static ReflectQuery of(Args spec) {
        Args expand = spec.object("expand");
        return new ReflectQuery(
            spec.stringMap("select"),
            expand == null ? null : expand.string("path", null),
            Values.Limits.of(spec.object("limits")),
            spec.flag("handles", false));
    }

    public int nodeCount() {
        return values.nodeCount();
    }

    public boolean truncated() {
        return values.truncated();
    }

    public Object walk(Object root) {
        return root == null ? null : node(root, 0, 0);
    }

    private Object node(Object target, int depth, int index) {
        if (!values.spend()) {
            return null;
        }
        Map<String, Object> node = new LinkedHashMap<>();
        node.put("class", target.getClass().getName());
        node.put("index", index);
        Integer repeat = seen.get(target);
        if (repeat != null) {
            node.put("$ref", repeat);
            return node;
        }
        seen.put(target, values.nodeCount());
        node.put("$id", values.nodeCount());
        if (handles) {
            node.put("handle", Handles.registerShared(target));
        }
        Map<String, Object> read = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : select.entrySet()) {
            read.put(entry.getKey(), read(target, entry.getValue()));
        }
        node.put("values", read);
        if (expandPath != null && depth < values.limits().maxDepth()) {
            List<Object> children = expand(target, depth);
            if (!children.isEmpty()) {
                node.put("children", children);
            }
        }
        return node;
    }

    private List<Object> expand(Object target, int depth) {
        List<Object> children = new ArrayList<>();
        Object edge;
        try {
            edge = Reflect.navigate(target, expandPath);
        } catch (Throwable error) {
            return children;
        }
        if (edge == null) {
            return children;
        }
        int index = 0;
        for (Object child : iterate(edge)) {
            if (child != null) {
                if (index >= values.limits().maxItems()) {
                    values.truncate();
                    break;
                }
                children.add(node(child, depth + 1, index));
            }
            index++;
        }
        return children;
    }

    private static Iterable<?> iterate(Object edge) {
        if (edge instanceof Iterable<?> iterable) {
            return iterable;
        }
        if (edge.getClass().isArray()) {
            List<Object> elements = new ArrayList<>();
            int length = java.lang.reflect.Array.getLength(edge);
            for (int i = 0; i < length; i++) {
                elements.add(java.lang.reflect.Array.get(edge, i));
            }
            return elements;
        }
        return List.of(edge);
    }

    private Object read(Object target, String path) {
        try {
            return values.leaf(Reflect.navigate(target, path));
        } catch (NoSuchFieldException | NoSuchMethodException missing) {
            return Values.absent();
        } catch (Throwable error) {
            return values.error(error);
        }
    }
}
