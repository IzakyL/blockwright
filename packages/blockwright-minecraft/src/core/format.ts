/** Small readers and formatters for reflect query values and reports. */
export function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function shortClass(className: string | null | undefined): string {
  if (!className) {
    return "unknown";
  }
  const index = className.lastIndexOf(".");
  return index === -1 ? className : className.slice(index + 1);
}

export function reflectText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "$string" in value) {
    return String((value as { $string: unknown }).$string);
  }
  return undefined;
}

/** A raw reflect.query value as a number, or the fallback when it is not one. */
export function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

/** A raw reflect.query value as a boolean, or the fallback when it is not one. */
export function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
