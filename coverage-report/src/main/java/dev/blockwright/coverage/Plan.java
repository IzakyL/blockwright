package dev.blockwright.coverage;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * What the driver needs before launching the game: the packages to instrument for the mod's own classes, and
 * the mixins plus their targets, whose transformed classes must be instrumented and dumped as well so that
 * merged mixin code gets execution data at all.
 */
final class Plan {
    private Plan() {
    }

    static JsonObject of(ModJars mods) {
        TreeSet<String> mixins = new TreeSet<>();
        TreeSet<String> targets = new TreeSet<>();
        for (ModJars.Mixin mixin : mods.mixins.values()) {
            mixins.add(dotted(mixin.name()));
            for (String target : mixin.targets()) {
                targets.add(dotted(target));
            }
        }
        JsonObject plan = new JsonObject();
        plan.add("packages", array(collapse(packagesOf(mods.classes.keySet()))));
        plan.add("mixins", array(mixins));
        plan.add("targets", array(targets));
        return plan;
    }

    /** Dotted packages of internal class names; classes in the default package have none. */
    static Set<String> packagesOf(Collection<String> classNames) {
        Set<String> packages = new TreeSet<>();
        for (String name : classNames) {
            int slash = name.lastIndexOf('/');
            if (slash > 0) {
                packages.add(name.substring(0, slash).replace('/', '.'));
            }
        }
        return packages;
    }

    /** Drops every package that is a sub-package of another one in the set; the result stays sorted. */
    static List<String> collapse(Collection<String> packages) {
        TreeSet<String> all = new TreeSet<>(packages);
        List<String> kept = new ArrayList<>();
        for (String pkg : all) {
            boolean covered = false;
            for (int dot = pkg.indexOf('.'); dot >= 0 && !covered; dot = pkg.indexOf('.', dot + 1)) {
                covered = all.contains(pkg.substring(0, dot));
            }
            if (!covered) {
                kept.add(pkg);
            }
        }
        return kept;
    }

    private static String dotted(String internal) {
        return internal.replace('/', '.');
    }

    private static JsonArray array(Collection<String> values) {
        JsonArray array = new JsonArray();
        values.forEach(array::add);
        return array;
    }
}
