package blockwright.minecraft.core;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.nbt.CollectionTag;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NumericTag;
import net.minecraft.nbt.Tag;

/**
 * An NBT path in the vanilla command syntax: compound keys, bare or quoted
 * ({@code "neoforge:attachments"."mod:state".Pack}), and {@code [index]} list steps, negative
 * indices counting from the end. Resolving it names the step that found nothing.
 */
public final class NbtPath {
    private sealed interface Step permits Key, Index {
    }

    private record Key(String name) implements Step {
        @Override
        public String toString() {
            return isBare(name) ? name : '"' + name.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
        }
    }

    private record Index(int index) implements Step {
        @Override
        public String toString() {
            return "[" + index + "]";
        }
    }

    private final String text;
    private final List<Step> steps;

    private NbtPath(String text, List<Step> steps) {
        this.text = text;
        this.steps = steps;
    }

    public static NbtPath parse(String text) {
        List<Step> steps = new ArrayList<>();
        int i = 0;
        int length = text.length();
        boolean expectKey = true;
        while (i < length) {
            char c = text.charAt(i);
            if (c == '[') {
                int close = text.indexOf(']', i);
                if (close < 0) {
                    throw invalid(text, "unclosed [");
                }
                String inside = text.substring(i + 1, close).trim();
                if (inside.isEmpty() || inside.startsWith("{")) {
                    throw invalid(text, "[" + inside + "] selects several elements; give a single index");
                }
                try {
                    steps.add(new Index(Integer.parseInt(inside)));
                } catch (NumberFormatException notNumber) {
                    throw invalid(text, "[" + inside + "] is not an index");
                }
                i = close + 1;
                expectKey = false;
            } else if (c == '.') {
                if (expectKey) {
                    throw invalid(text, "empty key before position " + i);
                }
                i++;
                expectKey = true;
            } else if (c == '{') {
                throw invalid(text, "compound filters {…} are not supported");
            } else if (!expectKey) {
                throw invalid(text, "expected . or [ at position " + i);
            } else if (c == '"' || c == '\'') {
                StringBuilder key = new StringBuilder();
                int j = i + 1;
                for (; j < length && text.charAt(j) != c; j++) {
                    char k = text.charAt(j);
                    if (k == '\\' && j + 1 < length) {
                        k = text.charAt(++j);
                    }
                    key.append(k);
                }
                if (j >= length) {
                    throw invalid(text, "unclosed quote " + c);
                }
                steps.add(new Key(key.toString()));
                i = j + 1;
                expectKey = false;
            } else {
                int j = i;
                while (j < length && ".[{\"'".indexOf(text.charAt(j)) < 0) {
                    j++;
                }
                steps.add(new Key(text.substring(i, j).trim()));
                i = j;
                expectKey = false;
            }
        }
        if (steps.isEmpty() || (expectKey && !steps.isEmpty())) {
            throw invalid(text, steps.isEmpty() ? "empty path" : "path ends with .");
        }
        return new NbtPath(text, steps);
    }

    /** The tag this path names under {@code root}; throws naming the first step that finds nothing. */
    public Tag resolve(Tag root) {
        Tag current = root;
        for (int i = 0; i < steps.size(); i++) {
            Step step = steps.get(i);
            String at = i == 0 ? "the root" : prefix(i);
            if (step instanceof Key key) {
                if (!(current instanceof CompoundTag compound)) {
                    throw missing(step, at + " is a " + kind(current) + ", not a compound");
                }
                Tag next = compound.get(key.name());
                if (next == null) {
                    throw missing(step, "no key " + key + " under " + at + keys(compound));
                }
                current = next;
            } else {
                int index = ((Index) step).index();
                if (!(current instanceof CollectionTag<?> list)) {
                    throw missing(step, at + " is a " + kind(current) + ", not a list");
                }
                int resolved = index < 0 ? list.size() + index : index;
                if (resolved < 0 || resolved >= list.size()) {
                    throw missing(step, "index " + index + " is out of range for " + at + " (size " + list.size() + ")");
                }
                current = list.get(resolved);
            }
        }
        return current;
    }

    private String prefix(int count) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < count; i++) {
            Step step = steps.get(i);
            if (i > 0 && step instanceof Key) {
                text.append('.');
            }
            text.append(step);
        }
        return text.toString();
    }

    private RuntimeException missing(Step step, String detail) {
        return Fail.notFound("nbtPath " + text + ": " + detail);
    }

    private static RuntimeException invalid(String text, String detail) {
        return Fail.invalid("invalid nbtPath " + text + ": " + detail);
    }

    private static String keys(CompoundTag compound) {
        List<String> keys = new ArrayList<>(compound.getAllKeys());
        keys.sort(null);
        if (keys.isEmpty()) {
            return " (it is empty)";
        }
        String shown = String.join(", ", keys.size() > 24 ? keys.subList(0, 24) : keys);
        return " (keys there: " + shown + (keys.size() > 24 ? ", … " + (keys.size() - 24) + " more" : "") + ")";
    }

    private static String kind(Tag tag) {
        if (tag instanceof CompoundTag) {
            return "compound";
        }
        if (tag instanceof CollectionTag<?>) {
            return "list";
        }
        return tag instanceof NumericTag ? "number (" + tag.getAsString() + ")" : "string (" + tag.getAsString() + ")";
    }

    private static boolean isBare(String name) {
        if (name.isEmpty()) {
            return false;
        }
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (!(Character.isLetterOrDigit(c) || c == '_' || c == '-' || c == '+')) {
                return false;
            }
        }
        return true;
    }
}
