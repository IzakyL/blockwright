package blockwright.minecraft.client;

import static blockwright.minecraft.core.Values.obj;

import java.util.Map;
import java.util.function.Consumer;

import net.neoforged.bus.api.EventPriority;
import net.neoforged.neoforge.client.event.InputEvent;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;

/**
 * What a dispatched mouse button went through, from the NeoForge events it fires: whether a mod cancelled
 * the raw event, whether the screen branch ran and handled it, and whether the vanilla keybind state was
 * updated (no screen, not cancelled). Listeners are added for one dispatch and removed right after, so a
 * reload of this module leaves nothing behind. Client thread.
 */
public final class InputWitness {
    private boolean preCanceled;
    private boolean postSent;
    private boolean screenBranch;
    private Boolean screenHandled;

    private InputWitness() {
    }

    /** Runs {@code dispatch} and answers what it went through. */
    public static Map<String, Object> watch(Runnable dispatch) {
        InputWitness witness = new InputWitness();
        Consumer<InputEvent.MouseButton.Pre> pre = event -> witness.preCanceled = event.isCanceled();
        Consumer<InputEvent.MouseButton.Post> post = event -> witness.postSent = true;
        Consumer<ScreenEvent.MouseButtonPressed.Pre> pressedPre = event -> witness.screenBranch = true;
        Consumer<ScreenEvent.MouseButtonReleased.Pre> releasedPre = event -> witness.screenBranch = true;
        Consumer<ScreenEvent.MouseButtonPressed.Post> pressedPost = event -> {
            witness.screenBranch = true;
            witness.screenHandled = event.wasClickHandled();
        };
        Consumer<ScreenEvent.MouseButtonReleased.Post> releasedPost = event -> {
            witness.screenBranch = true;
            witness.screenHandled = event.wasReleaseHandled();
        };
        var bus = NeoForge.EVENT_BUS;
        bus.addListener(EventPriority.LOWEST, true, InputEvent.MouseButton.Pre.class, pre);
        bus.addListener(EventPriority.LOWEST, InputEvent.MouseButton.Post.class, post);
        bus.addListener(EventPriority.LOWEST, true, ScreenEvent.MouseButtonPressed.Pre.class, pressedPre);
        bus.addListener(EventPriority.LOWEST, true, ScreenEvent.MouseButtonReleased.Pre.class, releasedPre);
        bus.addListener(EventPriority.LOWEST, ScreenEvent.MouseButtonPressed.Post.class, pressedPost);
        bus.addListener(EventPriority.LOWEST, ScreenEvent.MouseButtonReleased.Post.class, releasedPost);
        try {
            dispatch.run();
        } finally {
            bus.unregister(pre);
            bus.unregister(post);
            bus.unregister(pressedPre);
            bus.unregister(releasedPre);
            bus.unregister(pressedPost);
            bus.unregister(releasedPost);
        }
        return obj(
            "preCanceled", witness.preCanceled,
            "postSent", witness.postSent,
            "screenBranch", witness.screenBranch,
            "screenHandled", Boolean.TRUE.equals(witness.screenHandled),
            "vanillaStateUpdated", witness.postSent && !witness.preCanceled && !witness.screenBranch);
    }
}
