/**
 * Closes an instance, a driver or anything else with `close()`, preferring `closeAsync()` when present,
 * and ignoring whatever goes wrong. Answers the close result, or undefined when it failed.
 */
export async function closeQuietly<T>(closable: { close(): T | Promise<T>; closeAsync?(): T | Promise<T> } | undefined): Promise<T | undefined> {
  try {
    return closable?.closeAsync ? await closable.closeAsync() : await closable?.close();
  } catch {
    return undefined;
  }
}
