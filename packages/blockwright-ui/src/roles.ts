import { globMatches } from "@izakyl/blockwright-client";
import type { UiRole } from "./contract.js";

/**
 * A mod's own word on what an element is, for classes the built-in guesses get wrong. Globs match
 * the full class name or the element id; the first rule that matches wins.
 */
export interface RoleRule {
  className?: string;
  id?: string;
  role: UiRole;
}

/** Built-in guesses, by simple class name. */
export type RoleGuess = ReadonlyArray<readonly [RegExp, UiRole]>;

export function resolveRole(
  rules: readonly RoleRule[] | undefined,
  guesses: RoleGuess,
  subject: { className: string; id?: string },
  fallback: UiRole = "unknown",
): UiRole {
  for (const rule of rules ?? []) {
    if (rule.className === undefined && rule.id === undefined) {
      continue;
    }
    if (rule.className !== undefined && !globMatches(rule.className, subject.className)) {
      continue;
    }
    if (rule.id !== undefined && (subject.id === undefined || !globMatches(rule.id, subject.id))) {
      continue;
    }
    return rule.role;
  }
  const simple = subject.className.slice(subject.className.lastIndexOf(".") + 1);
  return guesses.find(([pattern]) => pattern.test(simple))?.[1] ?? fallback;
}
