package blockwright.minecraft.world;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.GameJson;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

import net.minecraft.world.entity.Entity;

/**
 * Which entities a query reports: {@code types} (ids, {@code minecraft:} implied), {@code typePatterns}
 * ({@code *} globs over type ids), {@code bounds} ({@code {min, max}} or {@code {center, radius}}),
 * {@code limit} (1..1000, default 100), and NBT ({@code nbt}, or {@code nbtPath} for one tag of it).
 * Types and patterns combine with "or"; bounds must also hold.
 */
public record EntityFilter(Set<String> types, List<Pattern> typePatterns, double[] box, int limit, boolean includeNbt,
                           String nbtPath) {
    private static final Pattern TYPE_ID = Pattern.compile("(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+");

    public static EntityFilter of(Args args) {
        Set<String> types = new LinkedHashSet<>();
        List<String> typeIds = args.strings("types");
        if (typeIds != null) {
            if (typeIds.isEmpty()) {
                throw Fail.invalid("args.types must not be empty (omit it to match every type)");
            }
            for (String id : typeIds) {
                if (!TYPE_ID.matcher(id).matches()) {
                    throw Fail.invalid("args.types: not an entity type id: " + id);
                }
                types.add(id.contains(":") ? id : "minecraft:" + id);
            }
        }
        List<Pattern> patterns = new ArrayList<>();
        List<String> globs = args.strings("typePatterns");
        if (globs != null) {
            for (String glob : globs) {
                patterns.add(glob(glob));
            }
        }
        String nbtPath = args.string("nbtPath", null);
        return new EntityFilter(types, patterns, bounds(args.object("bounds")),
            (int) args.integer("limit", 1, 1000, 100), args.flag("nbt", false) || (nbtPath != null && !nbtPath.isBlank()),
            nbtPath);
    }

    private static double[] bounds(Args bounds) {
        if (bounds == null) {
            return null;
        }
        if (bounds.has("min") && bounds.has("max")) {
            double[] min = bounds.xyz("min");
            double[] max = bounds.xyz("max");
            return new double[] {
                Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2]),
                Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])};
        }
        if (bounds.has("center")) {
            double[] c = bounds.xyz("center");
            double r = bounds.number("radius");
            if (r < 0) {
                throw Fail.invalid("args.bounds.radius must not be negative");
            }
            return new double[] {c[0] - r, c[1] - r, c[2] - r, c[0] + r, c[1] + r, c[2] + r};
        }
        throw Fail.invalid("args.bounds needs {min, max} or {center, radius}");
    }

    /** {@code *} matches any run of characters; everything else matches itself. */
    static Pattern glob(String pattern) {
        String[] literals = pattern.split("\\*", -1);
        StringBuilder regex = new StringBuilder();
        for (int i = 0; i < literals.length; i++) {
            regex.append(i == 0 ? "" : ".*").append(literals[i].isEmpty() ? "" : Pattern.quote(literals[i]));
        }
        return Pattern.compile(regex.toString());
    }

    public boolean matches(Entity entity) {
        if (!types.isEmpty() || !typePatterns.isEmpty()) {
            String type = GameJson.entityTypeId(entity.getType());
            if (!types.contains(type) && typePatterns.stream().noneMatch(p -> p.matcher(type).matches())) {
                return false;
            }
        }
        return box == null
            || (entity.getX() >= box[0] && entity.getX() <= box[3]
                && entity.getY() >= box[1] && entity.getY() <= box[4]
                && entity.getZ() >= box[2] && entity.getZ() <= box[5]);
    }
}
