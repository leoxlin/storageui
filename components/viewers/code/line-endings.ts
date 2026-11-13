/** Mixed separators stay read-only rather than being normalized on save. */
export function sourceLineSeparator(text: string): string | null {
  let separator: string | undefined
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    if (separator !== undefined && separator !== match[0]) return null
    separator = match[0]
  }
  return separator ?? "\n"
}
