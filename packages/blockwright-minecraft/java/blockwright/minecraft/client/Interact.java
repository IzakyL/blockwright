package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import blockwright.minecraft.core.Args;
import blockwright.minecraft.core.Fail;
import blockwright.minecraft.core.GameJson;
import blockwright.minecraft.core.Levels;
import blockwright.minecraft.core.client.ClientGame;
import blockwright.minecraft.core.client.Settle;
import dev.blockwright.api.Context;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.MultiPlayerGameMode;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.EntityHitResult;
import net.minecraft.world.phys.Vec3;
import org.lwjgl.glfw.GLFW;

/**
 * The player's interactions through {@code MultiPlayerGameMode}, the path a right click takes: use an item
 * on a block, use the held item, interact with an entity; and a click at whatever the crosshair is on. Each
 * answers once a barrier came back from the server, so the server has handled the interaction by then.
 * Client thread.
 */
public final class Interact {
    private Interact() {
    }

    private static MultiPlayerGameMode gameMode(Minecraft mc, String action) {
        ClientGame.player(mc, action);
        return mc.gameMode;
    }

    private static Map<String, Object> result(InteractionResult result) {
        return obj("result", ClientGame.lower(result), "consumed", result.consumesAction());
    }

    /**
     * {@code {pos, face?, hand?, cursor?, insideBlock?}}: {@code useItemOn} at the block {@code pos}, on
     * {@code face} (default up), at {@code cursor} (default the centre of that face).
     */
    public static CompletableFuture<Object> useBlock(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        MultiPlayerGameMode gameMode = gameMode(mc, "use a block");
        BlockPos pos = args.blockPos("pos");
        Direction face = ClientGame.constant(Direction.class, args.string("face", "up"), "face");
        InteractionHand hand = ClientGame.constant(InteractionHand.class, args.string("hand", "main-hand"), "hand");
        Vec3 cursor = args.has("cursor") ? args.vec3("cursor") : Vec3.atCenterOf(pos)
            .add(face.getStepX() * 0.5, face.getStepY() * 0.5, face.getStepZ() * 0.5);
        BlockHitResult hit = new BlockHitResult(cursor, face, pos, args.flag("insideBlock", false));
        String before = GameJson.blockId(mc.level.getBlockState(pos));
        InteractionResult outcome = gameMode.useItemOn(mc.player, hand, hit);
        Map<String, Object> answer = obj("pos", GameJson.pos(pos), "face", ClientGame.lower(face), "hand", ClientGame.lower(hand),
            "cursor", GameJson.vec(cursor), "block", before);
        answer.putAll(result(outcome));
        return Settle.afterServer(answer);
    }

    /** {@code {hand?}}: {@code useItem} with what the hand holds. */
    public static CompletableFuture<Object> useItem(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        MultiPlayerGameMode gameMode = gameMode(mc, "use an item");
        InteractionHand hand = ClientGame.constant(InteractionHand.class, args.string("hand", "main-hand"), "hand");
        Map<String, Object> item = GameJson.item(mc.player.getItemInHand(hand));
        InteractionResult outcome = gameMode.useItem(mc.player, hand);
        Map<String, Object> answer = obj("hand", ClientGame.lower(hand), "item", item);
        answer.putAll(result(outcome));
        return Settle.afterServer(answer);
    }

    /**
     * {@code {id | uuid, point?, hand?}}: {@code interactAt} the entity at {@code point} (default the centre
     * of its bounding box), then, if that did not consume the action, {@code interact} — what a right click on
     * an entity does.
     */
    public static CompletableFuture<Object> entity(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        MultiPlayerGameMode gameMode = gameMode(mc, "interact with an entity");
        Entity entity = findEntity(mc, args);
        Vec3 point = args.has("point") ? args.vec3("point") : entity.getBoundingBox().getCenter();
        InteractionHand hand = ClientGame.constant(InteractionHand.class, args.string("hand", "main-hand"), "hand");
        InteractionResult at = gameMode.interactAt(mc.player, entity, new EntityHitResult(entity, point), hand);
        InteractionResult fallback = at.consumesAction() ? null : gameMode.interact(mc.player, entity, hand);
        InteractionResult outcome = fallback == null ? at : fallback;
        Map<String, Object> answer = obj("entity", GameJson.entity(entity), "point", GameJson.vec(point), "hand", ClientGame.lower(hand),
            "interactAt", ClientGame.lower(at), "interact", fallback == null ? null : ClientGame.lower(fallback));
        answer.putAll(result(outcome));
        return Settle.afterServer(answer);
    }

    /** The entity {@code {id | uuid}} names in the client's own level; ends {@code not-found} when it is not loaded there. */
    public static Entity findEntity(Minecraft mc, Args args) {
        if (mc.level == null) {
            throw Fail.unavailable("the client is not in a world; there are no entities");
        }
        if (!args.has("id") && !args.has("uuid")) {
            throw Fail.invalid("an entity needs id or uuid");
        }
        Integer id = args.has("id") ? (int) args.integer("id") : null;
        UUID uuid = args.has("uuid") ? Levels.uuid(args.string("uuid")) : null;
        Entity entity = Levels.findEntity(mc.level, id, uuid);
        if (entity == null) {
            throw Fail.notFound("no entity with " + (id != null ? "id " + id : "uuid " + uuid) + " is loaded on the client");
        }
        return entity;
    }

    /**
     * A click of {@code button} (default left) at whatever the crosshair is on, with no screen open: the press
     * and release go through {@code MouseHandler.onPress}, the game acts on the keybind click in its next
     * tick, and the answer comes after a barrier through the server. {@code expect: {pos}} ends the run
     * {@code not-found} unless the crosshair is on that block first. Answers {@code {hitResult, dispatch}}.
     */
    public static CompletableFuture<Object> clickTarget(Context ctx, Args args) {
        Minecraft mc = ClientGame.mc(ctx);
        LocalPlayer player = ClientGame.player(mc, "click in the world");
        if (mc.screen != null) {
            throw Fail.unavailable("a screen is open (" + mc.screen.getClass().getName() + "), which would take the click");
        }
        Map<String, Object> hit = ClientState.hitResult(mc.hitResult);
        Args expect = args.object("expect");
        if (expect != null && expect.has("pos")) {
            BlockPos wanted = expect.blockPos("pos");
            if (!(mc.hitResult instanceof BlockHitResult block) || mc.hitResult.getType() != BlockHitResult.Type.BLOCK
                || !block.getBlockPos().equals(wanted)) {
                throw Fail.notFound("the crosshair is not on the block " + GameJson.pos(wanted) + " but on " + hit
                    + " (player at " + GameJson.vec(player.position()) + ", looking " + player.getYRot() + "/" + player.getXRot() + ")");
            }
        }
        int button = Mouse.buttonCode(args.string("button", "left"));
        int modifiers = Keys.modifiers(args);
        Map<String, Object> press = Mouse.button(mc, button, GLFW.GLFW_PRESS, modifiers);
        Map<String, Object> release = Mouse.button(mc, button, GLFW.GLFW_RELEASE, modifiers);
        Map<String, Object> answer = obj("button", Mouse.buttonName(button),
            "hitResult", hit, "dimension", Levels.dimension(mc.level), "dispatch", obj("press", press, "release", release));
        return Settle.afterTickAndServer(ctx, answer);
    }
}
