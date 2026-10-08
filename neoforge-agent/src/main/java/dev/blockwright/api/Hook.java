package dev.blockwright.api;

import java.util.Arrays;
import java.util.function.Consumer;

/**
 * A publish/subscribe point the agent raises from inside the game. Listeners run synchronously on the
 * publishing thread (each hook in {@link Hooks} documents which one), in subscription order.
 *
 * <p>A listener that throws never reaches the game: the exception goes to the listener's failure handler
 * (for {@link Context#subscribe} that ends the run with an {@code exception} error) or, without one, is
 * logged once per subscription.
 *
 * <p>Publishing to a hook without listeners costs one volatile read; publishers check {@link #active()}
 * before building an event.
 *
 * @param <E> the event type
 */
public final class Hook<E> {
    private static final Listener<?>[] NONE = new Listener<?>[0];

    private final String name;
    @SuppressWarnings("unchecked")
    private volatile Listener<E>[] listeners = (Listener<E>[]) NONE;

    /** Creates a hook. Modules may create their own hooks; the agent's are the constants in {@link Hooks}. */
    public Hook(String name) {
        this.name = name;
    }

    /** The hook's name, for diagnostics. */
    public String name() {
        return name;
    }

    /** Whether anything listens. Publishers skip building the event when this is false. */
    public boolean active() {
        return listeners.length != 0;
    }

    /** Subscribes {@code listener}; exceptions it throws are logged once and otherwise ignored. */
    public Registration subscribe(Consumer<? super E> listener) {
        return subscribe(listener, null);
    }

    /**
     * Subscribes {@code listener}; exceptions it throws go to {@code onFailure} (which must not throw),
     * or are logged when it is null. The listener stays subscribed after a failure.
     */
    public Registration subscribe(Consumer<? super E> listener, Consumer<Throwable> onFailure) {
        if (listener == null) {
            throw new NullPointerException("listener");
        }
        Listener<E> entry = new Listener<>(listener, onFailure);
        synchronized (this) {
            Listener<E>[] current = listeners;
            Listener<E>[] next = Arrays.copyOf(current, current.length + 1);
            next[current.length] = entry;
            listeners = next;
        }
        return () -> remove(entry);
    }

    private synchronized void remove(Listener<E> entry) {
        Listener<E>[] current = listeners;
        for (int index = 0; index < current.length; index++) {
            if (current[index] == entry) {
                @SuppressWarnings("unchecked")
                Listener<E>[] next = (Listener<E>[]) new Listener<?>[current.length - 1];
                System.arraycopy(current, 0, next, 0, index);
                System.arraycopy(current, index + 1, next, index, current.length - index - 1);
                listeners = next;
                return;
            }
        }
    }

    /** Delivers {@code event} to every listener on the calling thread. Never throws. */
    public void publish(E event) {
        Listener<E>[] current = listeners;
        for (Listener<E> listener : current) {
            try {
                listener.consumer.accept(event);
            } catch (Throwable failure) {
                listener.failed(this, failure);
            }
        }
    }

    @Override
    public String toString() {
        return "Hook[" + name + "]";
    }

    private static final class Listener<E> {
        final Consumer<? super E> consumer;
        final Consumer<Throwable> onFailure;
        volatile boolean logged;

        Listener(Consumer<? super E> consumer, Consumer<Throwable> onFailure) {
            this.consumer = consumer;
            this.onFailure = onFailure;
        }

        void failed(Hook<?> hook, Throwable failure) {
            try {
                if (onFailure != null) {
                    onFailure.accept(failure);
                    return;
                }
            } catch (Throwable ignored) {
                // A failure handler that fails must not reach the game either.
            }
            if (!logged) {
                logged = true;
                try {
                    org.slf4j.LoggerFactory.getLogger("blockwright").warn("listener of {} threw", hook.name, failure);
                } catch (Throwable ignored) {
                }
            }
        }
    }
}
