package dev.blockwright.api;

/**
 * Ends a run with a chosen error code. Thrown from {@code run}, from a hook listener registered through
 * {@link Context#subscribe}, or used to complete the returned stage exceptionally, it ends the run with
 * {@code {"end":"error","error":{"code":code,"message":message,"detail":detail}}} instead of the generic
 * {@code exception} code. The agent itself uses {@code unavailable} for hops to a thread the instance does
 * not have.
 */
public class TaskException extends RuntimeException {
    private final String code;
    private final transient Object detail;

    /**
     * @param code    a short lower-case code, such as {@code timeout} or {@code condition}
     * @param message a human readable message
     * @param detail  any value the JSON encoder accepts, or null
     */
    public TaskException(String code, String message, Object detail) {
        super(message);
        this.code = code == null || code.isBlank() ? "exception" : code;
        this.detail = detail;
    }

    public TaskException(String code, String message) {
        this(code, message, null);
    }

    /** The error code. */
    public String code() {
        return code;
    }

    /** The error detail, or null. */
    public Object detail() {
        return detail;
    }
}
