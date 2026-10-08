package blockwright.minecraft.core;

import static blockwright.minecraft.core.Values.obj;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.Tag;
import net.minecraft.world.Container;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.capabilities.Capabilities;
import net.neoforged.neoforge.items.IItemHandler;

/**
 * Game objects as JSON-ready Java values, the shapes every area reports them in (mirrored by the TS types in
 * {@code src/core/types.ts}). All readers work on server and client levels alike; call them on the thread
 * that owns the level.
 *
 * <ul>
 * <li>{@link #block}: {@code {id, state, properties}}; {@link #blockAt} adds {@code pos, dimension, blockEntity?, nbt?}</li>
 * <li>{@link #item}: {@code {id, count}} plus {@code name, damage, maxDamage, components} when they say something</li>
 * <li>{@link #slots}: {@code [{slot, id, count}]} for the non-empty slots</li>
 * <li>{@link #entity}: {@code {id, uuid, type, name, dimension, position, rotation, alive}}</li>
 * <li>{@link #player}: an entity plus {@code name, health, maxHealth, onGround, selectedSlot, mainHand}</li>
 * <li>{@link #inventory}: {@code {source, size?, slots}} or {@code {source: "none", readable: false}}</li>
 * <li>{@link #container}: {@code {pos, dimension, block, found, isContainer, size, source, slots, nbt?}}</li>
 * <li>{@link #nbt}: a tag walked by {@link Values} with {@link Values.Limits#NBT} (longs as strings)</li>
 * </ul>
 */
public final class GameJson {
    private GameJson() {
    }

    public static Map<String, Object> pos(BlockPos pos) {
        return obj("x", pos.getX(), "y", pos.getY(), "z", pos.getZ());
    }

    public static Map<String, Object> vec(Vec3 vec) {
        return obj("x", vec.x, "y", vec.y, "z", vec.z);
    }

    public static String blockId(BlockState state) {
        return BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
    }

    public static String itemId(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
    }

    public static String entityTypeId(EntityType<?> type) {
        return EntityType.getKey(type).toString();
    }

    public static Map<String, Object> block(BlockState state) {
        Map<String, Object> properties = new LinkedHashMap<>();
        for (Property<?> property : state.getProperties()) {
            properties.put(property.getName(), propertyValue(state, property));
        }
        return obj("id", blockId(state), "state", String.valueOf(state), "properties", properties);
    }

    private static <T extends Comparable<T>> String propertyValue(BlockState state, Property<T> property) {
        return property.getName(state.getValue(property));
    }

    /**
     * The block at {@code pos}, with its block entity's type and (when {@code nbt}) its saved data. Reads only
     * what is loaded: when the chunk holding {@code pos} is not loaded the answer is {@code {pos, dimension,
     * loaded: false}} without a state — asking never loads (or generates) a chunk. {@code loaded} is whether
     * that chunk is loaded, so a position above or below the build height of a loaded chunk answers
     * {@code loaded: true} with the game's void air.
     */
    public static Map<String, Object> blockAt(Level level, BlockPos pos, boolean nbt) {
        Map<String, Object> json = obj("pos", pos(pos), "dimension", Levels.dimension(level));
        // Ask the chunk source without loading; getBlockState on a ServerLevel would load (or generate) the chunk.
        if (!level.getChunkSource().hasChunk(SectionPos.blockToSectionCoord(pos.getX()), SectionPos.blockToSectionCoord(pos.getZ()))) {
            json.put("loaded", false);
            return json;
        }
        json.putAll(block(level.getBlockState(pos)));
        json.put("loaded", true);
        BlockEntity blockEntity = level.getBlockEntity(pos);
        if (blockEntity != null) {
            json.put("blockEntity", String.valueOf(BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(blockEntity.getType())));
            if (nbt) {
                json.put("nbt", nbt(blockEntity.saveWithoutMetadata(level.registryAccess()), Values.Limits.NBT));
            }
        }
        return json;
    }

    public static Map<String, Object> item(ItemStack stack) {
        if (stack == null || stack.isEmpty()) {
            return obj("id", "minecraft:air", "count", 0);
        }
        Map<String, Object> json = obj("id", itemId(stack), "count", stack.getCount());
        String name = stack.getHoverName().getString();
        if (!name.equals(stack.getItem().getDescription().getString())) {
            json.put("name", name);
        }
        if (stack.isDamageableItem()) {
            json.put("damage", stack.getDamageValue());
            json.put("maxDamage", stack.getMaxDamage());
        }
        if (!stack.getComponentsPatch().isEmpty()) {
            json.put("components", Values.clip(String.valueOf(stack.getComponentsPatch()), 4096));
        }
        return json;
    }

    /** The non-empty slots of {@code container}. */
    public static List<Object> slots(Container container) {
        List<Object> slots = new ArrayList<>();
        for (int slot = 0; slot < container.getContainerSize(); slot++) {
            addStack(slots, container.getItem(slot), slot);
        }
        return slots;
    }

    public static Map<String, Object> entity(Entity entity) {
        return obj(
            "id", entity.getId(),
            "uuid", String.valueOf(entity.getUUID()),
            "type", entityTypeId(entity.getType()),
            "name", entity.getName().getString(),
            "dimension", Levels.dimension(entity.level()),
            "position", obj("x", entity.getX(), "y", entity.getY(), "z", entity.getZ()),
            "rotation", obj("yaw", entity.getYRot(), "pitch", entity.getXRot()),
            "alive", entity.isAlive());
    }

    public static Map<String, Object> player(Player player) {
        Map<String, Object> json = entity(player);
        json.put("name", player.getGameProfile().getName());
        json.put("health", player.getHealth());
        json.put("maxHealth", player.getMaxHealth());
        json.put("onGround", player.onGround());
        json.put("selectedSlot", player.getInventory().selected);
        json.put("mainHand", item(player.getMainHandItem()));
        return json;
    }

    /** What an entity carries: a player's inventory, a container entity's slots, else item lists found in its NBT. */
    public static Map<String, Object> inventory(Entity entity) {
        Container container = entity instanceof Player player ? player.getInventory()
            : entity instanceof Container direct ? direct : null;
        if (container != null) {
            return obj("source", "container", "size", container.getContainerSize(), "slots", slots(container));
        }
        if (entityNbt(entity, null, Values.Limits.NBT, false) instanceof Map<?, ?> root) {
            for (String path : new String[] {"Inventory", "Items", "Inventory.Items", "inventory.Items"}) {
                if (at(root, path) instanceof List<?> list) {
                    List<Object> normalized = normalizeStackList(list);
                    if (normalized != null) {
                        return obj("source", "nbt:" + path, "slots", normalized);
                    }
                }
            }
        }
        if (entity instanceof LivingEntity living) {
            List<Object> slots = new ArrayList<>();
            int index = 0;
            for (ItemStack stack : living.getAllSlots()) {
                addStack(slots, stack, index++);
            }
            return obj("source", "equipment", "slots", slots);
        }
        return obj("source", "none", "readable", false, "slots", List.of());
    }

    /**
     * {@code entity}'s NBT (or the tag {@code nbtPath} names in it). A path that finds nothing ends the run
     * {@code not-found} when {@code strict}; otherwise the value is {@code {"$error": why}}.
     */
    public static Object entityNbt(Entity entity, String nbtPath, Values.Limits limits, boolean strict) {
        return entityNbt(entity, nbtPath, new Values(limits == null ? Values.Limits.NBT : limits), strict);
    }

    /**
     * {@link #entityNbt(Entity, String, Values.Limits, boolean)} walked by {@code walker}, which then tells
     * whether the limits cut anything ({@link Values#truncated()}); one walker may serve several entities.
     */
    public static Object entityNbt(Entity entity, String nbtPath, Values walker, boolean strict) {
        Tag tag;
        try {
            tag = entity.saveWithoutId(new CompoundTag());
        } catch (RuntimeException error) {
            return walker.error(error);
        }
        return nbt(tag, nbtPath, walker, strict);
    }

    /** {@code tag}, or the tag {@code nbtPath} names in it, walked with {@code limits}. */
    public static Object nbt(Tag tag, String nbtPath, Values.Limits limits, boolean strict) {
        return nbt(tag, nbtPath, new Values(limits == null ? Values.Limits.NBT : limits), strict);
    }

    /** {@code tag}, or the tag {@code nbtPath} names in it, walked by {@code walker} (see {@link Values#truncated()}). */
    public static Object nbt(Tag tag, String nbtPath, Values walker, boolean strict) {
        if (nbtPath != null && !nbtPath.isBlank()) {
            try {
                tag = NbtPath.parse(nbtPath).resolve(tag);
            } catch (RuntimeException missing) {
                if (strict) {
                    throw missing;
                }
                return obj("$error", missing.getMessage());
            }
        }
        return walker.encode(tag);
    }

    public static Object nbt(Tag tag, Values.Limits limits) {
        return new Values(limits == null ? Values.Limits.NBT : limits).encode(tag);
    }

    /** The items at {@code pos}: its {@link Container} block entity, else the item handler capability there. */
    public static Map<String, Object> container(Level level, BlockPos pos, boolean includeNbt) {
        Map<String, Object> result = obj("pos", pos(pos), "dimension", Levels.dimension(level),
            "block", blockId(level.getBlockState(pos)));
        BlockEntity blockEntity = level.getBlockEntity(pos);
        result.put("found", blockEntity != null);
        if (blockEntity != null) {
            result.put("blockEntity", blockEntity.getClass().getName());
        }
        List<Object> slots = null;
        if (blockEntity instanceof Container container) {
            slots = slots(container);
            result.put("size", container.getContainerSize());
            result.put("source", "container");
        } else {
            IItemHandler handler = Capabilities.ItemHandler.BLOCK.getCapability(level, pos, null, blockEntity, null);
            if (handler != null) {
                slots = new ArrayList<>();
                for (int slot = 0; slot < handler.getSlots(); slot++) {
                    addStack(slots, handler.getStackInSlot(slot), slot);
                }
                result.put("size", handler.getSlots());
                result.put("source", "item-handler-capability");
                result.put("handlerType", handler.getClass().getName());
            }
        }
        if (slots == null) {
            result.put("isContainer", false);
            result.put("reason", blockEntity == null
                ? "no block entity here, and no item handler capability is registered at this position"
                : "block entity implements neither the Container interface nor the item handler capability");
            return result;
        }
        result.put("isContainer", true);
        result.put("slots", slots);
        if (includeNbt && blockEntity != null) {
            result.put("nbt", nbt(blockEntity.saveWithoutMetadata(level.registryAccess()), Values.Limits.NBT));
        }
        return result;
    }

    private static void addStack(List<Object> slots, ItemStack stack, int slot) {
        if (stack.isEmpty()) {
            return;
        }
        Map<String, Object> json = obj("slot", slot);
        json.putAll(item(stack));
        slots.add(json);
    }

    private static Object at(Map<?, ?> root, String path) {
        Object current = root;
        for (String segment : path.split("\\.")) {
            if (!(current instanceof Map<?, ?> object)) {
                return null;
            }
            current = object.get(segment);
        }
        return current;
    }

    private static List<Object> normalizeStackList(List<?> list) {
        List<Object> slots = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            if (!(list.get(i) instanceof Map<?, ?> element)) {
                continue;
            }
            Map<?, ?> stack = element.get("Stack") instanceof Map<?, ?> nested ? nested : element;
            if (!(stack.get("id") instanceof String id)) {
                continue;
            }
            Object slot = element.get("Slot") != null ? element.get("Slot") : stack.get("Slot");
            Object count = stack.get("count");
            slots.add(obj("slot", slot instanceof Number number ? number.intValue() : i, "id", id,
                "count", count instanceof Number number ? number.intValue() : 1));
        }
        return slots.isEmpty() && !list.isEmpty() ? null : slots;
    }
}
