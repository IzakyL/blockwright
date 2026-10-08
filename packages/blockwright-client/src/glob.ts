export function globMatches(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return regex.test(value);
}
