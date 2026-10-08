package blockwright.minecraft.core;

import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;

/** Reflection arguments given as an id string: a {@code ResourceLocation}, or a registered item, block or entity type. */
public final class Registered {
    private Registered() {
    }

    /** {@code text} as a {@code target}, or null when {@code target} is not one of the id-named types. */
    public static Object of(Class<?> target, String text) {
        if (target == ResourceLocation.class) {
            return id(text);
        }
        if (Item.class.isAssignableFrom(target)) {
            return lookup(BuiltInRegistries.ITEM, "item", text, target);
        }
        if (Block.class.isAssignableFrom(target)) {
            return lookup(BuiltInRegistries.BLOCK, "block", text, target);
        }
        if (target == EntityType.class) {
            return lookup(BuiltInRegistries.ENTITY_TYPE, "entity type", text, target);
        }
        return null;
    }

    private static ResourceLocation id(String text) {
        ResourceLocation id = ResourceLocation.tryParse(text);
        if (id == null) {
            throw Fail.invalid("not a resource location: " + text);
        }
        return id;
    }

    private static Object lookup(Registry<?> registry, String kind, String text, Class<?> target) {
        Object found = registry.getOptional(id(text))
            .orElseThrow(() -> new IllegalArgumentException("no " + kind + " is registered as " + text));
        if (!target.isInstance(found)) {
            throw Fail.invalid(
                kind + " " + text + " is a " + found.getClass().getName() + ", not a " + target.getName());
        }
        return found;
    }
}
