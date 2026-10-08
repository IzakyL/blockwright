package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.GameJson;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.Wait;
import blockwright.minecraft.core.client.ClientGame;
import blockwright.minecraft.core.client.Settle;
import dev.blockwright.api.Context;
import dev.blockwright.api.access.ChatComponentAccessor;
import dev.blockwright.api.access.GuiAccessor;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

import net.minecraft.client.GuiMessage;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.HitResult;

/**
 * What the client shows and knows: HUD text, the cursor and crosshair target, the local player, entities
 * near it, and chat — reading the chat log, sending to it and waiting in the game for a message. Client
 * thread.
 */
public final class ClientState {
    private ClientState() {
    }

    /** {@code {actionBar, title, subtitle}}, each {@code {text, remainingTicks}} while shown, else null. */
    public static Map<String, Object> hudText(Minecraft mc) {
        GuiAccessor gui = (GuiAccessor) mc.gui;
        return obj(
            "actionBar", hudEntry(gui.blockwright$overlayMessage(), gui.blockwright$overlayMessageTime()),
            "title", hudEntry(gui.blockwright$title(), gui.blockwright$titleTime()),
            "subtitle", hudEntry(gui.blockwright$subtitle(), gui.blockwright$titleTime()));
    }

    private static Map<String, Object> hudEntry(Component component, int remainingTicks) {
        return component == null || remainingTicks <= 0 ? null
            : obj("text", component.getString(), "remainingTicks", remainingTicks);
    }

    /** {@code {type: miss|block|entity, location, pos?, face?, entity?}} or null. */
    public static Map<String, Object> hitResult(HitResult hit) {
        if (hit == null) {
            return null;
        }
        Map<String, Object> json = obj("type", ClientGame.lower(hit.getType()), "location", GameJson.vec(hit.getLocation()));
        if (hit instanceof BlockHitResult block && hit.getType() == HitResult.Type.BLOCK) {
            json.put("pos", GameJson.pos(block.getBlockPos()));
            json.put("face", ClientGame.lower(block.getDirection()));
        }
        if (hit instanceof EntityHitResult entity) {
            json.put("entity", GameJson.entity(entity.getEntity()));
        }
        return json;
    }

    /**
     * {@code {grabbed, screen, position: {x, y, ...}, carried, hitResult}}: whether the game holds the mouse,
     * the cursor (see {@link Mouse#cursor}), the stack carried on the cursor in a container screen (null when
     * none) and what the crosshair is on.
     */
    public static Map<String, Object> cursor(Minecraft mc) {
        return obj(
            "grabbed", mc.mouseHandler.isMouseGrabbed(),
            "screen", ClientGame.screenClass(mc),
            "position", Mouse.cursor(mc),
            "carried", mc.player == null || mc.player.containerMenu.getCarried().isEmpty() ? null
                : GameJson.item(mc.player.containerMenu.getCarried()),
            "hitResult", hitResult(mc.hitResult));
    }

    /** The local player (GameJson.player) plus food, saturation, exhaustion, game mode, eye height and vehicle; null outside a world. */
    public static Map<String, Object> player(Minecraft mc) {
        LocalPlayer player = mc.player;
        if (player == null || mc.level == null) {
            return null;
        }
        Map<String, Object> json = GameJson.player(player);
        json.put("food", player.getFoodData().getFoodLevel());
        json.put("saturation", player.getFoodData().getSaturationLevel());
        json.put("exhaustion", player.getFoodData().getExhaustionLevel());
        json.put("gameMode", mc.gameMode == null ? null : mc.gameMode.getPlayerMode().getName());
        json.put("eyeHeight", player.getEyeHeight());
        json.put("vehicle", player.getVehicle() == null ? null : GameJson.entity(player.getVehicle()));
        return json;
    }

    /** {@code {dimension, radius, entities: [entity + distance], count}}: loaded entities within {@code radius} of the player, nearest first. */
    public static Map<String, Object> nearby(Minecraft mc, double radius, int limit) {
        LocalPlayer player = ClientGame.player(mc, "look for entities near the player");
        List<Entity> found = new ArrayList<>();
        for (Entity entity : mc.level.entitiesForRendering()) {
            if (entity != player && entity.distanceToSqr(player) <= radius * radius) {
                found.add(entity);
            }
        }
        found.sort((a, b) -> Double.compare(a.distanceToSqr(player), b.distanceToSqr(player)));
        List<Object> entities = new ArrayList<>();
        for (Entity entity : found) {
            if (entities.size() >= limit) {
                break;
            }
            Map<String, Object> json = GameJson.entity(entity);
            json.put("distance", Math.sqrt(entity.distanceToSqr(player)));
            entities.add(json);
        }
        return obj("dimension", Levels.dimension(mc.level), "radius", radius, "entities", entities, "count", found.size());
    }

    /** The newest {@code limit} chat lines, oldest first. */
    public static List<String> messages(Minecraft mc, int limit) {
        List<GuiMessage> all = ((ChatComponentAccessor) mc.gui.getChat()).blockwright$allMessages();
        List<String> messages = new ArrayList<>();
        for (int index = Math.min(limit, all.size()) - 1; index >= 0; index--) {
            messages.add(all.get(index).content().getString());
        }
        return messages;
    }

    // ---- task entry points ----

    /**
     * The block at {@code pos} in the client's own level ({@code GameJson.blockAt}; {@code nbt} adds the
     * client-side block entity's data): what this client was sent, which is all a client of a remote server
     * has. {@code dimension}, when given, must be the client's.
     */
    public static Object block(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        Level level = mc.level;
        if (level == null) {
            throw Fail.unavailable("the client is not in a world");
        }
        String dimension = args.string("dimension", null);
        if (dimension != null && !dimension.isBlank()
            && !Levels.normalizeDimension(dimension).equals(Levels.dimension(level))) {
            throw Fail.notFound("the client is in " + Levels.dimension(level) + ", not "
                + Levels.normalizeDimension(dimension));
        }
        return GameJson.blockAt(level, args.blockPos("pos"), args.flag("nbt", false));
    }

    public static Object messagesTask(Context ctx, Args args) {
        return messages(ClientGame.mc(ctx), (int) args.integer("limit", 1, 100_000, 20));
    }

    public static Object nearbyTask(Context ctx, Args args) {
        return nearby(ClientGame.mc(ctx), args.number("radius", 16), (int) args.integer("limit", 0, 100_000, 100));
    }

    /**
     * Sends {@code message} as the player: a chat line, or a command when it starts with {@code /}. Answers
     * after a barrier through the server, so the server has handled it.
     */
    public static CompletableFuture<Object> chat(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        LocalPlayer player = ClientGame.player(mc, "chat");
        String message = args.string("message");
        if (message.isEmpty()) {
            throw Fail.invalid("message is empty");
        }
        boolean command = message.startsWith("/");
        if (command) {
            player.connection.sendCommand(message.substring(1));
        } else {
            player.connection.sendChat(message);
        }
        return Settle.afterServer(obj("message", message, "command", command));
    }

    /**
     * Waits (every client tick) for a chat line containing {@code contains} (or matching the regex
     * {@code pattern}) among lines added after the wait started ({@code includeExisting}: also the lines
     * already there). Answers {@code {message}}.
     */
    public static CompletableFuture<Object> waitForMessage(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        String contains = args.string("contains", null);
        Pattern pattern = args.has("pattern") ? Pattern.compile(args.string("pattern")) : null;
        if (contains == null && pattern == null) {
            throw Fail.invalid("waitForMessage needs contains or pattern");
        }
        List<GuiMessage> log = ((ChatComponentAccessor) mc.gui.getChat()).blockwright$allMessages();
        // allMessages is newest first; remember the newest line seen so far by identity.
        GuiMessage[] newestSeen = {args.flag("includeExisting", false) || log.isEmpty() ? null : log.get(0)};
        return Wait.until(ctx, Wait.Clock.CLIENT_TICK, Wait.Options.of(args.object("wait")), () -> {
            List<GuiMessage> all = ((ChatComponentAccessor) mc.gui.getChat()).blockwright$allMessages();
            List<String> fresh = new ArrayList<>();
            for (GuiMessage message : all) {
                if (message == newestSeen[0]) {
                    break;
                }
                fresh.add(0, message.content().getString());
            }
            for (String text : fresh) {
                if ((contains != null && text.contains(contains)) || (pattern != null && pattern.matcher(text).find())) {
                    return obj("message", text);
                }
            }
            return Wait.pending(obj("newMessages", fresh.size(), "last", fresh.isEmpty() ? null : fresh.get(fresh.size() - 1)));
        }).thenApply(result -> result.value());
    }
}
