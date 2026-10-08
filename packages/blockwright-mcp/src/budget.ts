export interface Budget {
  maxItems: number;
  maxKeys: number;
  maxDepth: number;
  maxString: number;
}

const DEFAULT_BUDGET: Budget = {
  maxItems: 20,
  maxKeys: 40,
  maxDepth: 6,
  maxString: 400,
};

export interface BudgetedValue {
  value: unknown;
  notes: string[];
}

export function clip(value: unknown, budget: Partial<Budget> = {}): BudgetedValue {
  const limits = { ...DEFAULT_BUDGET, ...budget };
  const notes: string[] = [];
  const walk = (input: unknown, depth: number, path: string): unknown => {
    if (typeof input === "string") {
      if (input.length > limits.maxString) {
        notes.push(`${path || "value"} cut to ${limits.maxString} chars (${input.length} total)`);
        return `${input.slice(0, limits.maxString)}…`;
      }
      return input;
    }
    if (input === null || typeof input !== "object") {
      return input;
    }
    if (depth >= limits.maxDepth) {
      notes.push(`${path} stopped at depth ${limits.maxDepth}`);
      return Array.isArray(input) ? `[… ${input.length} items]` : "{…}";
    }
    if (Array.isArray(input)) {
      const kept = input.slice(0, limits.maxItems).map((item, index) => walk(item, depth + 1, `${path}[${index}]`));
      if (input.length > limits.maxItems) {
        notes.push(`${path || "list"}: showing ${limits.maxItems} of ${input.length}, ${input.length - limits.maxItems} more`);
      }
      return kept;
    }
    const entries = Object.entries(input as Record<string, unknown>).filter(([, item]) => item !== undefined && item !== null);
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, limits.maxKeys)) {
      out[key] = walk(item, depth + 1, path ? `${path}.${key}` : key);
    }
    if (entries.length > limits.maxKeys) {
      notes.push(`${path || "object"}: showing ${limits.maxKeys} of ${entries.length} fields`);
    }
    return out;
  };
  return { value: walk(value, 0, ""), notes };
}

export function budgetedJson(value: unknown, budget: Partial<Budget> = {}): string {
  const clipped = clip(value, budget);
  const body = JSON.stringify(clipped.value, null, 2) ?? "null";
  if (clipped.notes.length === 0) {
    return body;
  }
  return `${body}\n\ntruncated:\n${clipped.notes.map((note) => `  ${note}`).join("\n")}`;
}
