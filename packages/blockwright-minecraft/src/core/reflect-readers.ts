/**
 * Strict readers for a reflect.invoke result: they read the `returned` value (or the field at a
 * dotted `path` under nested `$fields`), taking an object as its `$string`, and throw, naming what
 * was there, when it does not hold a value of the asked-for type.
 */

function node(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function at(result: unknown, path: string | undefined): unknown {
  let current = node(result)?.returned;
  for (const segment of (path ?? "").split(".").filter((part) => part.length > 0)) {
    const object = node(current);
    current = object ? (node(object.$fields) ?? object)[segment] : undefined;
  }
  return current;
}

function scalar(value: unknown): unknown {
  const object = node(value);
  if (!object) {
    return value;
  }
  return "$string" in object ? object.$string : undefined;
}

function describe(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? "undefined").slice(0, 200);
  } catch {
    return String(value);
  }
}

function reader<T>(kind: string, check: (value: unknown) => value is T): (result: unknown, path?: string) => T {
  return (result, path) => {
    const target = at(result, path);
    const value = scalar(target);
    if (check(value)) {
      return value;
    }
    throw new Error(
      `reflection result does not hold a ${kind}${path === undefined ? "" : ` at ${path}`}: got ${describe(target)}`,
    );
  };
}

export const reflectNumber = reader<number>(
  "number",
  (value): value is number => typeof value === "number" && Number.isFinite(value),
);

export const reflectBoolean = reader<boolean>("boolean", (value): value is boolean => typeof value === "boolean");

export const reflectString = reader<string>("string", (value): value is string => typeof value === "string");
