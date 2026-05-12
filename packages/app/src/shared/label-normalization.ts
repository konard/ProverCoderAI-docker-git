const isUpperSnakeAtom = (char: string): boolean => {
  const codePoint = char.codePointAt(0)
  return (
    codePoint !== undefined
    && ((codePoint >= 48 && codePoint <= 57) || (codePoint >= 65 && codePoint <= 90))
  )
}

/**
 * CHANGE: Share upper-snake label normalization across labeled env keys.
 * WHY: A single pure normalizer preserves the same key-space invariant for menu and GitLab labels.
 * SOURCE: n/a
 * FORMAT THEOREM: For every input, output is empty or a sequence of A-Z/0-9 segments separated by single underscores.
 * PURITY: CORE
 * INVARIANT: No leading underscore, no trailing underscore, and no repeated underscore.
 * COMPLEXITY: O(n) time and O(n) space, where n is the input string length.
 */
export const normalizeUpperSnakeLabel = (value: string | null | undefined): string => {
  const trimmed = value?.trim().toUpperCase() ?? ""
  if (trimmed.length === 0) {
    return ""
  }
  const normalized: Array<string> = []
  let previousWasSeparator = true
  for (const char of trimmed) {
    if (isUpperSnakeAtom(char)) {
      normalized.push(char)
      previousWasSeparator = false
      continue
    }
    if (!previousWasSeparator) {
      normalized.push("_")
      previousWasSeparator = true
    }
  }
  if (normalized.at(-1) === "_") {
    normalized.pop()
  }
  return normalized.join("")
}
