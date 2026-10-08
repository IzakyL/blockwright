/**
 * Closes an instance, a driver or anything else with `close()`, ignoring whatever goes wrong. Answers what
 * `close()` answered (for an instance, how the process ended), or undefined when it failed.
 */
export async function closeQuietly<T>(closable: { close(): T | Promise<T> } | undefined): Promise<T | undefined> {
  try {
    return await closable?.close();
  } catch {
    return undefined;
  }
}
