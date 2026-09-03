/**
 * Escape a string for literal use inside a RegExp.
 *
 * Shared so the two keyword matchers that build patterns from word lists —
 * `localized-page-detection` and the E-E-A-T analyzer — cannot end up escaping
 * different sets of characters.
 */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
